const fs = require("fs");
const path = require("path");
const { readJson, translatePosition, writeJson } = require("./sync-regions");

const ROOT = path.resolve(__dirname, "..");
const REGIONS_PATH = path.join(ROOT, "data", "regions-index.json");

function personBlocks(data = {}) {
  return Array.isArray(data.contentBlocks) ? data.contentBlocks.filter((block) => block.type === "person") : [];
}

function syncContentBlockPositions(data = {}) {
  const byId = new Map((data.people || []).map((person) => [String(person.id), person]));
  for (const block of personBlocks(data)) {
    const person = byId.get(String(block.id));
    if (person) block.positionZh = person.positionZh;
  }
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const requested = new Set(args.filter((arg) => arg !== "--write"));
  const regions = readJson(REGIONS_PATH, []).filter((region) => !requested.size || requested.has(region.key));
  const issues = [];

  for (const region of regions) {
    const dataPath = path.join(ROOT, "data", `${region.key}-people.json`);
    if (!fs.existsSync(dataPath)) continue;
    const data = readJson(dataPath, { people: [] });
    let changed = false;

    for (const person of data.people || []) {
      const expected = translatePosition(person.position, region);
      if (person.positionZh !== expected) {
        issues.push({
          region: region.key,
          personId: person.id,
          name: person.name,
          position: person.position,
          current: person.positionZh || "",
          expected,
        });
        if (write) {
          person.positionZh = expected;
          changed = true;
        }
      }
    }

    if (write && changed) {
      syncContentBlockPositions(data);
      writeJson(dataPath, data);
    }
  }

  if (issues.length) {
    issues.forEach((issue) => {
      console.log([
        issue.region,
        issue.personId,
        issue.name,
        issue.position,
        issue.current,
        issue.expected,
      ].join("\t"));
    });
    if (!write) {
      console.error(`Position audit failed: ${issues.length} mismatch(es). Run with --write to update JSON.`);
      process.exit(1);
    }
    console.log(`Position audit updated ${issues.length} mismatch(es).`);
    return;
  }

  console.log(`Position audit passed for ${regions.length} region(s).`);
}

main();
