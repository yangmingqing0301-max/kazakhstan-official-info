const fs = require("node:fs");
const path = require("node:path");

const SOURCE_URL = "https://www.gov.kz/memleket/entities/astana/about/structure?lang=en";
const OUT_PATH = path.join(__dirname, "..", "data", "astana-structure.json");

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; SilkRoadInfoSync/1.0)",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  let cheerio;

  try {
    cheerio = require("cheerio");
  } catch {
    cheerio = null;
  }

  const payload = cheerio
    ? parseWithCheerio(cheerio.load(html))
    : parseWithoutCheerio(html);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    `${JSON.stringify(
      {
        sourceUrl: SOURCE_URL,
        syncedAt: new Date().toISOString(),
        ...payload,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function parseWithCheerio($) {
  $("script, style, noscript, svg, header, footer, nav").remove();

  const title = normalizeText($("title").first().text()) || "Astana structure";
  const pageText = normalizeText($("body").text());
  const links = unique(
    $("a")
      .map((_, element) => normalizeText($(element).text()))
      .get(),
  ).slice(0, 80);

  const cards = [];
  $("div, article, section, li").each((_, element) => {
    const text = normalizeText($(element).text());
    if (
      text.length >= 40 &&
      text.length <= 900 &&
      /phone|e-mail|email|reception|chief|akim|deputy/i.test(text)
    ) {
      cards.push(text);
    }
  });

  return {
    title,
    summaryText: pageText.slice(0, 4000),
    links,
    structureItems: unique(cards).slice(0, 40),
  };
}

function parseWithoutCheerio(html) {
  const text = normalizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );

  return {
    title: "Astana structure",
    summaryText: text.slice(0, 4000),
    links: [],
    structureItems: [],
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
