const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REGIONS_PATH = path.join(ROOT, "data", "regions-index.json");

const BAD_CHARS = /[?骞鏈绉闈璇戣瀹鍔欏鏂濉厠钀褰锟�]/;
const CYRILLIC = /[\u0400-\u04ff]{2,}/;
const PENDING = /中文译文待同步|待同步内容|暂无官方同步内容/;
const BAD_LATIN_TERMS = /\b(the|from|with|without|implementation|interaction|coordination|development|provision|responsible|regional|district|department|office|mayor|deputy|chief|head|specialist|inspector|secretary|committee|ministry|administration|government|president|republic|kazakhstan|state|institution|national|public|social|economic|budget|planning|finance|agriculture|investment|tourism|construction|architecture|urban|healthcare|employment|programs|services|appeals|complaints|assigned|powers|engineering|engineer|director|chairman|akim|apparatus|maslikhat|akkol|bulandy|arshalynsky|zharkainsky|tselinograd|khleborob|kostanay|sarykol|uralsk|uritsky|jsc|llp|too|si|lycl)\b/i;
const BAD_MACHINE_TERMS = /阿基姆|阿基马特|NC\s*KTZ|特纳|库斯塔奈|阿克莫拉地区|地区阿基姆|区的\s*区长|扎尔凯恩斯基|阿尔沙雷\s+区|布兰迪\s+区|阿科勒\s+区|Temirtau/i;

const ALLOWED_LATIN = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  /Center for Strategic Initiatives LLP/gi,
  /AQ Management/gi,
  /Polistrogroup LLP/gi,
  /Fire Safeti Engineering LLP/gi,
  /BI Group/gi,
  /Kuryer Kazakhstana/gi,
  /Qazaqstan Dauiri/gi,
  /Qostanai Tany/gi,
  /NatsTrubPlast/gi,
  /Narymbetov|Bakytzhan|Haberovich/gi,
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stripAllowed(value) {
  return ALLOWED_LATIN.reduce((text, regex) => text.replace(regex, ""), String(value || ""));
}

function hasTranslationIssue(value) {
  const text = String(value || "");
  if (!text.trim()) return false;
  if (PENDING.test(text)) return true;
  if (BAD_CHARS.test(text)) return true;
  if (CYRILLIC.test(text)) return true;
  if (BAD_MACHINE_TERMS.test(text)) return true;
  const scan = stripAllowed(text);
  if (BAD_LATIN_TERMS.test(scan)) return true;
  const latinWords = scan.match(/[A-Za-z]{3,}/g) || [];
  return latinWords.some((word) => /^[a-z]+$/.test(word) || /(tion|ment|ing|ity|ics|ance|ence|sky)$/i.test(word));
}

function collectChineseFields(value, currentPath = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectChineseFields(item, currentPath.concat(index), out));
    return out;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, child]) => {
      if (key.endsWith("Zh")) collectChineseFields(child, currentPath.concat(key), out);
      else if (["text", "items", "rows"].includes(key) && currentPath.some((part) => String(part).endsWith("Zh"))) collectChineseFields(child, currentPath.concat(key), out);
    });
    return out;
  }
  if (typeof value === "string") out.push({ path: currentPath.join("."), text: value });
  return out;
}

function main() {
  const requested = new Set(process.argv.slice(2));
  const regions = readJson(REGIONS_PATH).filter((region) => !requested.size || requested.has(region.key));
  const issues = [];

  for (const region of regions) {
    const dataPath = path.join(ROOT, "data", `${region.key}-people.json`);
    if (!fs.existsSync(dataPath)) continue;
    const data = readJson(dataPath);
    for (const person of data.people || []) {
      for (const field of collectChineseFields(person)) {
        if (field.path === "nameZh") continue;
        if (hasTranslationIssue(field.text)) {
          issues.push({
            region: region.key,
            personId: person.id,
            name: person.name,
            path: field.path,
            text: field.text.slice(0, 220),
          });
        }
      }
    }
  }

  if (issues.length) {
    issues.forEach((issue) => {
      console.log(`${issue.region}\t${issue.personId}\t${issue.name}\t${issue.path}\t${issue.text}`);
    });
    console.error(`Translation audit failed: ${issues.length} issue(s).`);
    process.exit(1);
  }

  console.log(`Translation audit passed for ${regions.length} region(s).`);
}

main();
