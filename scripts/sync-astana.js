const fs = require("node:fs");
const path = require("node:path");

const SOURCE_URL = "https://www.gov.kz/memleket/entities/astana/about/structure?lang=en";
const OUT_PATH = path.join(__dirname, "..", "data", "astana-structure.json");

function normalizeText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function stripSecurityNotice(value = "") {
  const text = normalizeText(value);
  return /(Ақпараттық қауіпсіздік|Доступ на интернет-ресурс временно ограничен|support\.sts\.kz)/i.test(text)
    ? ""
    : text;
}

function htmlToText(value = "") {
  return String(value)
    .replace(/<\/(p|li|div|h[1-6]|ol|ul)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .split(/\n+/)
    .map(normalizeText)
    .filter(Boolean)
    .join("\n");
}

function readExistingPayload() {
  try {
    return JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const existing = readExistingPayload();
  const payload = await scrapeWithPlaywright().catch(async (error) => {
    console.warn(`Playwright scrape failed: ${error.message}`);
    return scrapeStaticHtml().catch((fallbackError) => {
      console.warn(`Static scrape failed: ${fallbackError.message}`);
      return { people: [], warning: fallbackError.message };
    });
  });

  let people =
    payload.people && payload.people.length > 0 ? mergePeople(payload.people, existing?.people || []) : existing?.people || [];

  if ((!payload.people || payload.people.length === 0) && people.length > 0) {
    people = await enrichExistingPeopleFromApi(people);
  }
  const output = {
    sourceUrl: SOURCE_URL,
    syncedAt: new Date().toISOString(),
    title: "Astana city administration structure",
    people,
    warning: people.length === 0 ? payload.warning || "No people were extracted from the source page." : undefined,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

function mergePeople(freshPeople, existingPeople) {
  const existingByName = new Map(existingPeople.map((person) => [normalizeText(person.name).toLowerCase(), person]));

  return freshPeople.map((person) => {
    const existing = existingByName.get(normalizeText(person.name).toLowerCase()) || {};
    return {
      ...person,
      phone: chooseLonger(person.phone, existing.phone),
      receptionPhone: chooseLonger(person.receptionPhone, existing.receptionPhone || existing.phone),
      detail: person.detail || existing.detail || existing.career || "",
      career: person.career || existing.career || existing.detail || "",
      generalInfo: person.generalInfo || existing.generalInfo || "",
      careerHistory: person.careerHistory || existing.careerHistory || "",
      responsibilities: person.responsibilities || existing.responsibilities || "",
    };
  });
}

function chooseLonger(primary = "", fallback = "") {
  const first = normalizeText(primary);
  const second = normalizeText(fallback);
  return second.length > first.length ? second : first;
}

async function scrapeWithPlaywright() {
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    userAgent: "Mozilla/5.0 (compatible; SilkRoadInfoSync/1.0)",
  });

  try {
    await page.goto(SOURCE_URL, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(3500);

    const people = await page.evaluate(() => {
      const source = location.href;

      function clean(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function absoluteUrl(value) {
        try {
          return value ? new URL(value, source).href : "";
        } catch {
          return "";
        }
      }

      function textLines(node) {
        return String(node.innerText || "")
          .split(/\n|(?=Phone number:)|(?=E-mail:)|(?=Reception dates:)|(?=Areas of work)|(?=Supervised areas)|(?=Biography)/i)
          .map(clean)
          .filter(Boolean);
      }

      function guessName(lines) {
        return (
          lines.find(
            (line) =>
              /^[A-Z][A-Za-z' -]+ [A-Z][A-Za-z' -]+/.test(line) &&
              line.length < 90 &&
              !/(Akim|Mayor|Deputy|Chief|Head|Phone|E-mail|Reception|Biography|Areas of work)/i.test(line),
          ) ||
          lines[0] ||
          ""
        );
      }

      function cleanName(value) {
        return clean(value).replace(/\s+(Mayor|Akim|First Deputy Akim|Deputy Akim|Deputy Mayor|Chief of Staff.*)$/i, "");
      }

      function extractAfter(text, labelPattern, stopPattern) {
        const label = text.match(labelPattern);
        if (!label) return "";
        const start = label.index + label[0].length;
        const tail = text.slice(start);
        const stop = tail.search(stopPattern);
        return clean(stop >= 0 ? tail.slice(0, stop) : tail);
      }

      const cards = Array.from(document.querySelectorAll("article, li, section, div"))
        .filter((node) => {
          const text = clean(node.innerText);
          return (
            text.length > 80 &&
            text.length < 1400 &&
            /(Phone number|E-mail|Biography|Reception dates|Supervised areas)/i.test(text) &&
            node.querySelector("img")
          );
        })
        .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains(node)));

      return cards.map((card) => {
        const fullText = clean(card.innerText);
        const lines = textLines(card);
        const name = cleanName(guessName(lines));
        const biographyLink = Array.from(card.querySelectorAll("a")).find((link) =>
          /biography/i.test(clean(link.innerText)),
        );
        const photo = card.querySelector("img");
        const phone = fullText.match(/\+7[\d\s()–-]{8,}/)?.[0] || "";
        const email = fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
        const position =
          lines.find((line) => line !== name && /^(Mayor|Akim|First Deputy Akim|Deputy Akim|Deputy Mayor|Chief of Staff|Head)/i.test(line)) ||
          lines.find((line) => line !== name && /(Akim|Mayor|Deputy|Chief of Staff)/i.test(line) && line.length < 120) ||
          "";
        const directions = extractAfter(
          fullText,
          /(Areas of work|Supervised areas|Curated directions|Responsible areas):?/i,
          /(Phone number|Phone:|E-mail|Reception dates|Biography)/i,
        );

        return {
          name,
          position,
          photo: absoluteUrl(photo?.getAttribute("src") || photo?.getAttribute("data-src")),
          phone: clean(phone),
          email: clean(email),
          biographyUrl: absoluteUrl(biographyLink?.getAttribute("href")),
          career: "",
          detail: "",
          responsibilities: directions,
        };
      });
    });

    await enrichBiographies(browser, people);
    return { people: compactPeople(people) };
  } finally {
    await browser.close();
  }
}

async function enrichBiographies(browser, people) {
  const targets = people.filter((person) => person.biographyUrl).slice(0, 20);

  for (const person of targets) {
    const apiDetails = await fetchCuratorDetails(person).catch((error) => {
      console.warn(`Curator API failed for ${person.name}: ${error.message}`);
      return null;
    });

    if (apiDetails) {
      Object.assign(person, apiDetails);
      continue;
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(person.biographyUrl, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(1200);
      const biography = await page.evaluate(() => {
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll("script, style, header, footer, nav, svg").forEach((node) => node.remove());
        return String(clone.innerText || "").replace(/\s+/g, " ").trim();
      });
      person.detail = stripSecurityNotice(biography).slice(0, 2800);
      person.career = person.detail;
    } catch (error) {
      person.career = "";
      person.biographyWarning = error.message;
    } finally {
      await page.close();
    }
  }
}

async function enrichExistingPeopleFromApi(people) {
  const updated = [];

  for (const person of people) {
    if (!person.biographyUrl) {
      updated.push(person);
      continue;
    }

    const apiDetails = await fetchCuratorDetails(person).catch((error) => {
      console.warn(`Curator API failed for ${person.name}: ${error.message}`);
      return null;
    });

    updated.push(apiDetails ? { ...person, ...apiDetails } : person);
  }

  return updated;
}

async function fetchCuratorDetails(person) {
  const id = person.biographyUrl.match(/people\/(\d+)/)?.[1];
  if (!id) return null;

  const response = await fetch(`https://www.gov.kz/api/v1/public/content-manager/curators/${id}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; SilkRoadInfoSync/1.0)",
      accept: "application/json",
      "accept-language": "en",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const generalInfo = stripSecurityNotice(htmlToText(data.biography || ""));
  const careerHistory = stripSecurityNotice(htmlToText(data.biography_details || ""));

  return {
    name: normalizeText([data.lastname, data.name, data.middlename].filter(Boolean).join(" ")) || person.name,
    position: normalizeText(data.level?.items?.[0]?.position || data.position || person.position),
    photo: data.photo ? new URL(data.photo, "https://www.gov.kz").href : person.photo,
    phone: normalizeText(data.phone || person.phone),
    receptionPhone: normalizeText(data.public_reception_phone || data.phone || person.receptionPhone || person.phone),
    email: normalizeText(data.email || person.email),
    biographyUrl: `https://www.gov.kz/memleket/entities/astana/about/structure/people/${id}?lang=en`,
    career: [generalInfo, careerHistory].filter(Boolean).join("\n"),
    detail: [generalInfo, careerHistory].filter(Boolean).join("\n"),
    generalInfo,
    careerHistory,
  };
}

function compactPeople(people) {
  const seen = new Set();

  return people
    .map((person) => ({
      name: normalizeText(person.name),
      position: normalizeText(person.position),
      photo: normalizeText(person.photo),
      phone: normalizeText(person.phone),
      receptionPhone: normalizeText(person.receptionPhone),
      email: normalizeText(person.email),
      biographyUrl: normalizeText(person.biographyUrl),
      career: normalizeText(person.career),
      detail: stripSecurityNotice(person.detail || person.career),
      generalInfo: normalizeText(person.generalInfo),
      careerHistory: normalizeText(person.careerHistory),
      responsibilities: normalizeText(person.responsibilities),
    }))
    .filter((person) => person.name && !seen.has(person.name) && seen.add(person.name));
}

async function scrapeStaticHtml() {
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
  const text = normalizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );

  return {
    people: [],
    warning: text.includes("enable JavaScript")
      ? "Source page requires JavaScript rendering."
      : "Static HTML did not contain person cards.",
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
