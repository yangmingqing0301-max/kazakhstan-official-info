const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "data", "regions-index.json");
const DISCLAIMER = "本页面内容翻译自原网站，中文翻译仅供参考。";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function beijingMidnightIso(date = new Date()) {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, "0");
  const day = String(beijing.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00+08:00`;
}

function hasBadGeneratedChinese(value = "") {
  const text = String(value || "");
  if (!text) return true;
  if (/[�袗袦袝脨脩鑷姣曞伐]/.test(text)) return true;
  if (/[А-Яа-яЁё]{3,}/.test(text)) return true;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  if (cjk > text.length * 0.18) return false;
  const latin = (text.match(/[A-Za-z]{3,}/g) || []).join("").length;
  return latin > text.length * 0.28;
}

function detectSourceLanguage(value = "", fallback = "en") {
  const text = String(value || "");
  if (/[ӘәІіҢңҒғҮүҰұҚқӨөҺһ]/.test(text)) return "kk";
  return /[А-Яа-яЁё]{3,}/.test(text) ? "ru" : fallback;
}

function splitForTranslation(value = "") {
  const parts = [];
  const paragraphs = String(value || "")
    .replace(/袗t\b/g, "At")
    .replace(/[袦袝袨袪袧袛校携孝协褌褔械]+/g, " ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.length <= 450) {
      parts.push(paragraph);
      continue;
    }

    let current = "";
    for (const sentence of paragraph.split(/(?<=[.!?;])\s+/)) {
      if (current && current.length + sentence.length > 420) {
        parts.push(current.trim());
        current = "";
      }
      if (sentence.length > 450) {
        for (let index = 0; index < sentence.length; index += 420) {
          if (current.trim()) {
            parts.push(current.trim());
            current = "";
          }
          parts.push(sentence.slice(index, index + 420).trim());
        }
      } else {
        current += `${sentence} `;
      }
    }
    if (current.trim()) parts.push(current.trim());
  }

  return parts;
}

function translatePosition(position = "", region) {
  const text = String(position || "").trim();
  const lower = text.toLowerCase();

  if (!text) return "职务待同步";
  if (/akim of|mayor|әкім|аким/i.test(text) && !/deputy/i.test(text)) return `${region.nameZh}行政长官`;
  if (/first deputy/i.test(text)) return "第一副行政长官";
  if (/deputy/i.test(text)) return "副行政长官";
  if (/chief of staff|head of apparatus|руководитель аппарата/i.test(text)) return "办公室主任";
  if (/head of/i.test(lower) || /руководитель/i.test(lower)) return "部门负责人";
  if (/assistant/i.test(lower)) return "助理";
  if (/advisor|adviser/i.test(lower)) return "顾问";
  return text;
}

function buildTasks(data, region) {
  const tasks = [];

  data.people.forEach((person, personIndex) => {
    for (const field of ["generalInfo", "careerHistory"]) {
      const targetField = field === "generalInfo" ? "generalInfoZh" : "careerHistoryZh";
      if (!person[field]) {
        person[targetField] = "暂无官方同步内容";
        continue;
      }
      if (person[targetField] && !hasBadGeneratedChinese(person[targetField])) continue;
      tasks.push({
        personIndex,
        targetField,
        sourceLanguage: detectSourceLanguage(person[field], region.sourceLanguage || "en"),
        chunks: splitForTranslation(person[field]),
      });
    }

    if (!person.positionZh || hasBadGeneratedChinese(person.positionZh)) {
      person.positionZh = translatePosition(person.position, region);
    }
    if (!person.workScopeZh || hasBadGeneratedChinese(person.workScopeZh)) {
      person.workScopeZh = person.responsibilities || "官方页面未列出单独工作范围。";
    }
    person.translationNote = DISCLAIMER;
  });

  return tasks;
}

function translateTask(task) {
  if (!task || !task.chunks || task.chunks.length === 0) return "";

  const psScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$inputJson = [Console]::In.ReadToEnd()
$task = $inputJson | ConvertFrom-Json
$parts = New-Object System.Collections.Generic.List[string]
foreach ($chunk in $task.chunks) {
  $encoded = [System.Net.WebUtility]::UrlEncode([string]$chunk)
  $url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=$($task.sourceLanguage)&tl=zh-CN&dt=t&q=$encoded"
  $translated = $null
  for ($i = 1; $i -le 5; $i++) {
    try {
      $response = Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'Mozilla/5.0 (compatible; SilkRoadInfoSync/1.0)' } -TimeoutSec 45
      $translated = (($response[0] | ForEach-Object { $_[0] }) -join '').Trim()
      break
    } catch {
      if ($i -eq 5) { throw }
      Start-Sleep -Seconds ($i * 2)
    }
  }
  if ($translated) { $parts.Add($translated) }
  Start-Sleep -Milliseconds 120
}
[pscustomobject]@{ text = ($parts -join [Environment]::NewLine) } | ConvertTo-Json -Depth 4
`;

  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", psScript], {
    input: JSON.stringify(task),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
    timeout: 600000,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `PowerShell exited with ${result.status}`);
  }

  const output = result.stdout.trim();
  if (!output) return "";
  const parsed = JSON.parse(output);
  return parsed.text || "";
}

function finalizePeople(data) {
  data.people.forEach((person) => {
    person.detailZh = [person.generalInfoZh, person.careerHistoryZh].filter(Boolean).join("\n");
    person.translationNote = DISCLAIMER;
  });
}

function refreshRegion(region) {
  const filePath = path.join(ROOT, "data", `${region.key}-people.json`);
  const data = readJson(filePath);
  const tasks = buildTasks(data, region);
  console.log(`${region.key}: ${tasks.length} fields to translate`);

  let refreshed = 0;
  for (const task of tasks) {
    const person = data.people[task.personIndex];
    person[task.targetField] = translateTask(task) || "暂无官方同步内容";
    refreshed += 1;
    finalizePeople(data);
    data.syncedAt = beijingMidnightIso();
    writeJson(filePath, data);
    console.log(`${region.key}: refreshed ${refreshed}/${tasks.length}`);
  }

  finalizePeople(data);
  data.syncedAt = beijingMidnightIso();
  writeJson(filePath, data);
  console.log(`${region.key}: refreshed ${refreshed} fields`);
}

function main() {
  const regions = readJson(CONFIG_PATH);
  const selected = process.argv.slice(2);
  const targets = selected.length > 0 ? regions.filter((region) => selected.includes(region.key)) : regions;

  if (targets.length === 0) {
    throw new Error("No matching region keys.");
  }

  for (const region of targets) {
    refreshRegion(region);
  }
}

main();
