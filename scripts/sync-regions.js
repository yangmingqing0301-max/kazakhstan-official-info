const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "data", "regions-index.json");
const GOV_BASE = "https://www.gov.kz";
const DISCLAIMER = "本页面内容翻译自原网站，中文翻译仅供参考。";
const TRANSLATION_PENDING_ZH = "中文译文待同步，请以页面底部来源链接为准。";
const translationCache = new Map();

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
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

function normalizeText(value = "") {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function decodeHtml(value = "") {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    laquo: "«",
    raquo: "»",
    ldquo: "“",
    rdquo: "”",
    ndash: "–",
    mdash: "—",
  };
  return String(value || "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const key = entity.toLowerCase();
      if (key[0] === "#") {
        const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return entities[key] ?? match;
    });
}

function stripTags(value = "") {
  return normalizeText(decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")));
}

function absoluteGovUrl(value = "") {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `${GOV_BASE}${value.startsWith("/") ? "" : "/"}${value}`;
}

function slugify(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function splitTopLevel(html = "", tagName) {
  const result = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  let match;
  while ((match = regex.exec(html))) result.push(match[0]);
  return result;
}

function htmlToStructuredBlocks(html = "") {
  const blocks = [];
  let working = String(html || "")
    .replace(/\r/g, "")
    .replace(/<br\s*\/?\s*>/gi, "\n");

  working = working.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows = [];
    for (const rowHtml of splitTopLevel(tableHtml, "tr")) {
      const cells = [];
      const cellRegex = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let cell;
      while ((cell = cellRegex.exec(rowHtml))) {
        const text = stripTags(cell[2]);
        cells.push({ type: "cell", text, header: cell[1].toLowerCase() === "th" });
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) blocks.push({ type: "table", rows });
    return "\n";
  });

  working = working.replace(/<(ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi, (listHtml, tag) => {
    const items = [];
    const itemRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let item;
    while ((item = itemRegex.exec(listHtml))) {
      const text = stripTags(item[1]);
      if (text) items.push({ type: "listItem", text });
    }
    if (items.length) blocks.push({ type: "list", ordered: tag.toLowerCase() === "ol", items });
    return "\n";
  });

  working = working.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const text = stripTags(inner);
    if (text) blocks.push({ type: "heading", level: Number(level), text });
    return "\n";
  });

  working = working
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<(p|div)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ");

  for (const paragraph of decodeHtml(working).split(/\n+/).map(normalizeText).filter(Boolean)) {
    blocks.push({ type: "paragraph", text: paragraph });
  }
  return blocks;
}

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "table") {
    return (block.rows || [])
      .map((row) => row.map((cell) => cell.text || "").filter(Boolean).join(" | "))
      .filter(Boolean)
      .join("\n");
  }
  if (block.type === "list") return (block.items || []).map(blockText).filter(Boolean).join("\n");
  return block.text || "";
}

function blocksToText(blocks = []) {
  return blocks.map(blockText).filter(Boolean).join("\n");
}

function collectTextNodes(blocks = [], nodes = []) {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (["heading", "paragraph", "link", "listItem", "cell"].includes(block.type) && block.text) nodes.push(block);
    if (Array.isArray(block.items)) collectTextNodes(block.items, nodes);
    if (Array.isArray(block.rows)) block.rows.forEach((row) => collectTextNodes(row, nodes));
  }
  return nodes;
}

function collectSourceTexts(blocks = []) {
  return collectTextNodes(blocks).map((node) => node.text || "");
}

function collectTranslatedSourceTexts(blocks = []) {
  return collectTextNodes(blocks).map((node) => node.sourceText || "");
}

function hasBadChinese(value = "") {
  const text = String(value || "");
  if (!text) return true;
  if (text.includes(TRANSLATION_PENDING_ZH)) return true;
  if (text.includes("?")) return true;
  if (/[�锟]|[\u4e00-\u9fff]\?|[\u0400-\u04ff]\?|[骞鏈绉闈璇戣瀹鍔浜妗欏鏂濉槼厠钀褰]/.test(text)) return true;
  if (/[\u0400-\u04ff]{2,}/.test(text)) return true;
  if (/阿基姆|阿基马特|NC\s*KTZ|特纳|库斯塔奈|阿克莫拉地区|地区阿基姆|区的\s*区长|扎尔凯恩斯基|阿尔沙雷\s+区|布兰迪\s+区|阿科勒\s+区|Temirtau/i.test(text)) return true;
  const scan = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/Center for Strategic Initiatives LLP|AQ Management|Polistrogroup LLP|Fire Safeti Engineering LLP|BI Group|Kaznur|LLP|JSC|TOO|Kuryer Kazakhstana|Qazaqstan Dauiri|Qostanai Tany|NatsTrubPlast|Narymbetov|Bakytzhan|Haberovich/gi, "");
  if (/\b(the|from|with|without|implementation|interaction|coordination|development|provision|responsible|regional|district|department|office|mayor|deputy|chief|head|specialist|inspector|secretary|committee|ministry|administration|government|president|republic|kazakhstan|state|institution|national|public|social|economic|budget|planning|finance|agriculture|investment|tourism|construction|architecture|urban|healthcare|employment|programs|services|appeals|complaints|assigned|powers|engineering|engineer|director|chairman|akim|apparatus|maslikhat|akkol|bulandy|arshalynsky|zharkainsky|tselinograd|khleborob)\b/i.test(scan)) return true;
  const latinWords = scan.match(/[A-Za-z]{3,}/g) || [];
  if (latinWords.some((word) => /^[a-z]+$/.test(word) || /(tion|ment|ing|ity|ics|ance|ence|sky)$/i.test(word))) return true;
  return latinWords.join("").length > text.length * 0.45;
}

function blocksHaveBadChinese(blocks = []) {
  return collectTextNodes(blocks).some((node) => hasBadChinese(node.text));
}

function blockTranslationStillMatches(sourceBlocks = [], translatedBlocks = []) {
  const sourceTexts = collectSourceTexts(sourceBlocks);
  const translatedSources = collectTranslatedSourceTexts(translatedBlocks);
  return sourceTexts.length > 0 && sourceTexts.length === translatedSources.length && sourceTexts.every((text, index) => text === translatedSources[index]);
}

function splitForTranslation(value = "") {
  const parts = [];
  for (const paragraph of String(value || "").split(/\n+/).map((line) => line.trim()).filter(Boolean)) {
    if (paragraph.length <= 1200) {
      parts.push(paragraph);
      continue;
    }
    for (let index = 0; index < paragraph.length; index += 1000) parts.push(paragraph.slice(index, index + 1000));
  }
  return parts;
}

function translateChunkArrayWithPowerShell(chunks, sourceLanguage) {
  if (!chunks.length) return [];
  const encodedChunks = Buffer.from(JSON.stringify(chunks), "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedChunks}'))
$chunks = $json | ConvertFrom-Json
$marker = '[[[COD3X_SEGMENT]]]'
$results = New-Object System.Collections.Generic.List[string]
$bundles = New-Object System.Collections.Generic.List[object]
$current = New-Object System.Collections.Generic.List[string]
$currentLength = 0
foreach ($chunk in $chunks) {
  $chunkText = [string]$chunk
  if ($current.Count -gt 0 -and ($currentLength + $chunkText.Length) -gt 3200) {
    $bundles.Add($current.ToArray())
    $current = New-Object System.Collections.Generic.List[string]
    $currentLength = 0
  }
  $current.Add($chunkText)
  $currentLength += $chunkText.Length + 30
}
if ($current.Count -gt 0) { $bundles.Add($current.ToArray()) }
foreach ($bundle in $bundles) {
  $joined = [string]::Join(([Environment]::NewLine + $marker + [Environment]::NewLine), [string[]]$bundle)
  $encoded = [System.Net.WebUtility]::UrlEncode($joined)
  $url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLanguage || "auto"}&tl=zh-CN&dt=t&q=$encoded"
  $translated = $null
  for ($i = 1; $i -le 3; $i++) {
    try {
      $response = Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'Mozilla/5.0 (compatible; SilkRoadInfoSync/1.0)' } -TimeoutSec 30
      $translated = (($response[0] | ForEach-Object { $_[0] }) -join '').Trim()
      break
    } catch {
      if ($i -eq 3) { throw }
      Start-Sleep -Seconds ($i * 2)
    }
  }
  $parts = [regex]::Split($translated, '\\s*\\[\\[\\[COD3X_SEGMENT\\]\\]\\]\\s*')
  if ($parts.Count -eq $bundle.Count) {
    foreach ($part in $parts) { $results.Add(([string]$part).Trim()) }
  } else {
    foreach ($item in $bundle) { $results.Add('') }
  }
  Start-Sleep -Milliseconds 120
}
$results | ConvertTo-Json -Compress
`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", maxBuffer: 1024 * 1024 * 50 }).trim();
  const parsed = JSON.parse(output || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function translateChunks(chunks, sourceLanguage) {
  const results = new Array(chunks.length);
  const missing = [];
  const missingIndexes = [];
  chunks.forEach((chunk, index) => {
    const key = `${sourceLanguage || "auto"}\u0000${chunk}`;
    if (translationCache.has(key)) results[index] = translationCache.get(key);
    else {
      missing.push(chunk);
      missingIndexes.push(index);
    }
  });
  if (missing.length) {
    const translated = translateChunkArrayWithPowerShell(missing, sourceLanguage);
    translated.forEach((value, localIndex) => {
      const index = missingIndexes[localIndex];
      const key = `${sourceLanguage || "auto"}\u0000${chunks[index]}`;
      results[index] = value || "";
      translationCache.set(key, results[index]);
    });
  }
  return results;
}

function polishChineseTranslation(value = "", sourceText = "") {
  const source = String(sourceText || "").trim();
  let text = String(value || "").trim();
  if (!source && (!text || text.includes(TRANSLATION_PENDING_ZH))) return "";
  if (/^e-?mail\s*:/i.test(source)) return source.replace(/^e-?mail\s*:/i, "电子邮箱：");
  if (/^Department staff\s*:?$/i.test(source)) return "部门人员：";
  if (/^(Head|Chief)\s+Specialist$/i.test(source)) return "首席专家";
  if (/^Leading\s+Specialist$/i.test(source)) return "领先专家";
  if (/^General\s+Inspector$/i.test(source)) return "总督察";
  if (/^Inspector$/i.test(source)) return "监察员";
  if (/^[+()\d\s-]{5,}$/.test(source)) return source;
  if (/^[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){1,3}$/.test(source)) return source;
  if (!text || text.includes(TRANSLATION_PENDING_ZH)) text = source;
  if (/^In 1994-1998 - akim of the Naumovsky rural district of the Akkol district\.$/i.test(source)) return "1994-1998年 - 阿科勒区瑙莫夫斯基乡区区长。";
  if (/^In 1989-1994 - turner, assistant foreman, foreman of the MTF of the Khleborob state farm of the Akkol district of the Akmola region\.$/i.test(source)) return "1989-1994年 - 阿克莫拉州阿科勒区赫列博罗布国营农场奶牛场车工、副工长、工长。";
  if (/^In 1998-1999 - consultant of the organizational and control department of the apparatus of the akim of the Akmola region\.$/i.test(source)) return "1998-1999年 - 阿克莫拉州州长办公室组织和监督部门顾问。";
  if (/^In 1999-2000 - head of the apparatus of the akim of the Tselinograd district\.$/i.test(source)) return "1999-2000年 - 策利诺格勒区区长办公室主任。";
  if (/^In 2000-2008 - deputy akim of the Akkol district\.$/i.test(source)) return "2000-2008年 - 阿科勒区副区长。";
  if (/^In 2008-2009 - deputy head, head of the department of the branch of JSC NC KTZ - Economic Management\.$/i.test(source)) return "2008-2009年 - “哈萨克斯坦铁路”国家公司经济管理分公司副负责人、部门负责人。";
  if (/^In 2009-2012 - Director of the Department of JSC "Center for Development and Protection of Competition Policy"/i.test(source)) return "2009-2012年 - 股份公司“竞争政策发展与保护中心”部门主任；哈萨克斯坦共和国竞争保护署调查局国家机关反竞争行为调查处负责人；哈萨克斯坦共和国竞争保护署科斯塔奈州和北哈萨克斯坦州跨区域监察局负责人。";
  if (/^In 2012-2014 - Akim of Bulandy district\.$/i.test(source)) return "2012-2014年 - 布兰迪区区长。";
  if (/^In 2014-2015 - Deputy Head of the Department of Entrepreneurship and Industry of Akmola region\.$/i.test(source)) return "2014-2015年 - 阿克莫拉州创业和工业局副负责人。";
  if (/^In 2015-2017 - Head of the Department of Agriculture of Akmola region\.$/i.test(source)) return "2015-2017年 - 阿克莫拉州农业局负责人。";
  if (/^In 2017-2021 - Akim of Zharkainsky district\.$/i.test(source)) return "2017-2021年 - 扎尔凯恩区区长。";
  if (/^In 2021-2022 - Secretary of Akmola regional maslikhat\.$/i.test(source)) return "2021-2022年 - 阿克莫拉州议会秘书。";
  if (/^In 2022-2024 - Akim of Arshalynsky district\.$/i.test(source)) return "2022-2024年 - 阿尔沙雷区区长。";
  if (/^Represents the regional akimat in relations:?$/i.test(source)) return "代表州政府处理相关对外关系：";
  if (/^Coordination of the work of the first deputy, deputy akims of the region/i.test(source)) return "协调第一副州长、副州长、州长办公室主任、州级执行机构、各区区长以及科克舍套市、科希市和斯捷普诺戈尔斯克市市长的工作，并协调哈萨克斯坦共和国中央国家机关各驻地机构的运行。";
  if (/^First Deputy Akim of the Region for Housing and Utilities and Infrastructure Development$/i.test(source)) return "负责住房、公用事业和基础设施发展的州第一副州长";
  if (/^Heads:\s*the regional akimat/i.test(source)) return "负责领导州政府、州预算委员会、吸引投资者和改善投资环境委员会、州协调委员会，以及其他由官方页面列明的州级协调机构。";
  if (/^Ensuring interaction with the Administration of the President/i.test(source)) return "确保与哈萨克斯坦共和国总统办公厅和总理办公室的沟通协作，准备关于落实总统、总理及其办公厅指示情况的信息材料。";
  if (/^Functional responsibilities:\s*Coordination of activities of state institutions/i.test(source)) return "职能职责：协调国家机构、组织、企业和经济主体在农业、兽医、土地、水关系、自然资源利用和环境保护领域的活动；就监督事项与地方执行机构、区市政府办公室互动；监测农业部门宏观经济指标和预算使用情况；监督州长、副州长和州长办公室主任指令的执行。";
  if (/^Functional responsibilities:\s*Managing the work of the department/i.test(source)) return "职能职责：管理部门工作，监督文书工作要求和有关申请审议法律规定的遵守情况；组织并控制国家元首、总统办公厅、总理和总理办公室指令的及时执行；保障个人和法人电子及其他申请处理，组织州政府领导接待公民，并推动现代电子文档管理工具的使用。";
  if (/^Functional responsibilities:\s*Organizational support of the activities of the regional akim and akimat/i.test(source)) return "职能职责：为州长和州政府活动提供组织保障；向管理层通报受控文件和指令执行情况；为州长参与的活动筹备和举行提供组织支持；对组织和督查部门工作进行方法指导和日常管理；向管理层通报州内各地区工作情况；分析并监测国家元首、哈萨克斯坦共和国政府和中央国家机关指令执行质量；监督并执行州政府行政部门和州长办公室的相关指令。";
  if (/^Responsibilities:\s*General management of the press service/i.test(source)) return "职责：全面管理州长新闻服务工作；通过媒体形成公众对州长和州政府工作的客观认知；组织与经认证媒体的工作，准备新闻材料并协调公开传播。";
  if (/^Functional responsibilities:\s*General management of the department\. Ensuring the activities of the regional akim/i.test(source)) return "职能职责：全面管理部门工作；保障州长及州长办公室在信息通信技术领域的活动；分析技术设备、软件和信息系统使用效果，推进数字化和信息化相关工作。";
  if (/^Functions of the Department:\s*Ensuring the activities of the regional akim/i.test(source)) return "部门职能：保障州长及州长办公室在信息通信技术领域的活动；分析技术设备、软件和信息系统使用效果，推进数字化和信息化相关工作。";
  if (/^Functional responsibilities:\s*General management of the department\. Conducting legal expertise/i.test(source)) return "职能职责：全面管理部门工作；对州长和州政府法律文件草案进行法律审查；为决议、命令和其他文件发布提供法律支持，并处理相关法律事务。";
  if (/^Functions of the department:\s*Management of the work of the department/i.test(source)) return "部门职能：管理部门工作，组织州政府、州长和州长办公室活动的文书保障；组织并监督国家元首、总统办公厅、总理和总理办公室指令及时执行。";
  if (/^From 2017 to 2019, he served as Executive Director, CEO, and Managing Partner of Center for Strategic Initiatives LLP/i.test(source)) return "2017年至2019年，任哈萨克斯坦私营咨询公司 Center for Strategic Initiatives LLP 执行主任、首席执行官和管理合伙人。";
  if (/^From 2022 to 2024, he worked as Managing Director of the private company AQ Management and Polistrogroup LLP/i.test(source)) return "2022年至2024年，任私营公司 AQ Management 和 Polistrogroup LLP 管理主任。";
  if (/^по\s+н\/?время$/i.test(source)) return "至今";
  const bornMatch = source.match(/^(.+?), born on ([A-Za-z]+) (\d{1,2}), (\d{4}) in (?:the )?(.+?), has a higher education\.$/i);
  if (bornMatch) {
    const monthMap = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    const placeMap = new Map([["city of Uralsk", "乌拉尔斯克市"], ["Mendykarinsky district of the Kostanay region", "科斯塔奈州门迪卡拉区"]]);
    return `${bornMatch[1].replace(/\s+/g, " ").replace(/Bak ytzhan/i, "Bakytzhan")}，${bornMatch[4]}年${monthMap[bornMatch[2].toLowerCase()]}月${Number(bornMatch[3])}日出生于${placeMap.get(bornMatch[5]) || bornMatch[5]}，具有高等教育学历。`;
  }
  if (source === "He began his career in April 2011 as a site foreman at Fire Safeti Engineering LLP. Until July 2015, he worked as a construction site foreman, engineer, deputy director, and foreman in private construction companies in Astana, including the BI Group holding.") {
    return "他于2011年4月开始职业生涯，在 Fire Safeti Engineering LLP 担任施工现场工长。2015年7月前，他在阿斯塔纳的私营建筑公司工作，包括 BI Group 控股公司，历任施工现场工长、工程师、副主任和工长。";
  }
  const exactMap = new Map([
    ["Ethics Commissioner of the Akim's Office of Kostanay Region", "科斯塔奈州州长办公室伦理专员"],
    ["Deputy Editor of the newspaper “Kuryer Kazakhstana”, Kostanay", "《Kuryer Kazakhstana》报副主编，科斯塔奈"],
    ["Journalist of the newspaper “Qazaqstan Dauiri”, Kostanay", "《Qazaqstan Dauiri》报记者，科斯塔奈"],
    ["Journalist of the newspaper “Qostanai Tany”, Kostanay", "《Qostanai Tany》报记者，科斯塔奈"],
    ["Executive Director, LLP “NatsTrubPlast”, Kostanay", "“NatsTrubPlast”有限责任合伙企业执行董事，科斯塔奈"],
  ]);
  if (exactMap.has(source)) return exactMap.get(source);
  if (/Ethics Commissioner/i.test(source)) return "科斯塔奈州州长办公室伦理专员";
  if (/Deputy Editor of the newspaper/i.test(source)) return "《Kuryer Kazakhstana》报副主编，科斯塔奈";
  if (/Journalist of the newspaper “Qazaqstan Dauiri”/i.test(source)) return "《Qazaqstan Dauiri》报记者，科斯塔奈";
  if (/Journalist of the newspaper “Qostanai Tany”/i.test(source)) return "《Qostanai Tany》报记者，科斯塔奈";
  if (/Executive Director, LLP/i.test(source)) return "“NatsTrubPlast”有限责任合伙企业执行董事，科斯塔奈";
  text = text
    .replace(/^In\s+(\d{4}(?:-\d{4})?)\s*-\s*/i, "$1 年 - ")
    .replace(/^In\s+(\d{4})-(\d{4})\s*-\s*/i, "$1-$2 年 - ")
    .replace(/^Since\s+(\d{4})\s*-\s*/i, "$1 年起 - ")
    .replace(/^Since\s+([A-Za-z]+)\s+(\d{4})/i, "$2年起")
    .replace(/\bin\s+(\d{4})\b/gi, "$1年")
    .replace(/\bIn\s+/g, "")
    .replace(/Deputy Mayor/g, "副州长")
    .replace(/Deputy Akim/g, "副州长")
    .replace(/Deputy Mayor of Akmola region/gi, "阿克莫拉州副州长")
    .replace(/Deputy Akim of Akmola region/gi, "阿克莫拉州副州长")
    .replace(/First deputy akim/gi, "第一副州长")
    .replace(/Deputy Head of the Department/gi, "部门副负责人")
    .replace(/Head of the Department/gi, "部门负责人")
    .replace(/Head of the apparatus/gi, "办公室主任")
    .replace(/head of the apparatus/gi, "办公室主任")
    .replace(/deputy head/gi, "副负责人")
    .replace(/head of the department/gi, "部门负责人")
    .replace(/\bhead\b/gi, "负责人")
    .replace(/\bDirector\b/g, "主任")
    .replace(/\bdepartment\b/gi, "部门")
    .replace(/\bbranch\b/gi, "分公司")
    .replace(/\bconsultant\b/gi, "顾问")
    .replace(/\bsecretary\b/gi, "秘书")
    .replace(/\bturner\b/gi, "车工")
    .replace(/\bassistant foreman\b/gi, "副工长")
    .replace(/\bforeman\b/gi, "工长")
    .replace(/\bstate farm\b/gi, "国营农场")
    .replace(/\brural district\b/gi, "乡区")
    .replace(/\bdistrict\b/gi, "区")
    .replace(/\bregion\b/gi, "州")
    .replace(/Akim of Kostanay region/gi, "科斯塔奈州州长")
    .replace(/mayor of Kostanay region/gi, "科斯塔奈州州长")
    .replace(/deputy mayor of Kostanay region/gi, "科斯塔奈州副州长")
    .replace(/Kostanay region/g, "科斯塔奈州")
    .replace(/Kostanay district/g, "科斯塔奈区")
    .replace(/Republic of Kazakhstan/g, "哈萨克斯坦共和国")
    .replace(/по н\/время/gi, "至今")
    .replace(/Nationalit(?:y|ies)/gi, "民族")
    .replace(/Country of study/gi, "学习国家")
    .replace(/Year of graduation/gi, "毕业年份")
    .replace(/Years of study/gi, "学习年份")
    .replace(/Educational institution/gi, "教育机构")
    .replace(/Education: Higher education/gi, "教育程度：高等教育")
    .replace(/Major/gi, "专业")
    .replace(/Specialty/gi, "专业")
    .replace(/Qualification/gi, "资格")
    .replace(/present time/gi, "至今")
    .replace(/\bAkmola region\b/gi, "阿克莫拉州")
    .replace(/\bAkkol district\b/gi, "阿科勒区")
    .replace(/\bAkkol\b/gi, "阿科勒")
    .replace(/\bKhleborob\b/gi, "赫列博罗布")
    .replace(/\bNaumovsky rural district\b/gi, "瑙莫夫斯基乡区")
    .replace(/\bTselinograd district\b/gi, "策利诺格勒区")
    .replace(/\bBulandy district\b/gi, "布兰迪区")
    .replace(/\bBulandy\b/gi, "布兰迪")
    .replace(/\bZharkainsky district\b/gi, "扎尔凯恩区")
    .replace(/\bZharkainsky\b/gi, "扎尔凯恩")
    .replace(/\bArshalynsky district\b/gi, "阿尔沙雷区")
    .replace(/\bArshalynsky\b/gi, "阿尔沙雷")
    .replace(/\bTemirtau city\b/gi, "铁米尔套市")
    .replace(/\bTemirtau\b/gi, "铁米尔套")
    .replace(/\bZhangeldinsky district\b/gi, "张格尔丁区")
    .replace(/\bZhangeldinsky\b/gi, "张格尔丁")
    .replace(/\bKostanay region\b/gi, "科斯塔奈州")
    .replace(/\bKostanay\b/gi, "科斯塔奈")
    .replace(/\bNorth Kazakhstan Regions?\b/gi, "北哈萨克斯坦州")
    .replace(/\bUlytau region\b/gi, "乌勒套州")
    .replace(/\bKokshetau\b/gi, "科克舍套")
    .replace(/\bMTF\b/g, "奶牛场")
    .replace(/\bJSC\s+NC\s+KTZ\b/gi, "“哈萨克斯坦铁路”国家公司")
    .replace(/\bNC\s+KTZ\b/gi, "“哈萨克斯坦铁路”国家公司")
    .replace(/\bNC\s+SEC\b/gi, "国家社会企业公司")
    .replace(/\bJSC\b/g, "股份公司")
    .replace(/阿克莫拉地区阿基姆机构/g, "阿克莫拉州州长办公室")
    .replace(/阿克莫拉州阿基姆机构/g, "阿克莫拉州州长办公室")
    .replace(/阿克莫拉地区 Akim 办公室/g, "阿克莫拉州州长办公室")
    .replace(/阿克莫拉地区的阿基姆/g, "阿克莫拉州州长")
    .replace(/该地区的阿基姆/g, "该州州长")
    .replace(/地区阿基姆办公室/g, "州长办公室")
    .replace(/地区行政长官/g, "州长")
    .replace(/地区长官/g, "州长")
    .replace(/阿基马特/g, "州政府")
    .replace(/阿基姆机构/g, "州长办公室")
    .replace(/Akim 办公室/g, "州长办公室")
    .replace(/apparatus of the akim/gi, "州长办公室")
    .replace(/apparatus/gi, "办公室")
    .replace(/(\S+?)区的 Akim/g, "$1区区长")
    .replace(/(\S+?)区的阿基姆/g, "$1区区长")
    .replace(/Akim of ([^.\n]+?)区/gi, "$1区区长")
    .replace(/\bAkim\b/g, "区长")
    .replace(/阿基姆/g, "州长")
    .replace(/地区议会/g, "州议会")
    .replace(/regional maslikhat/gi, "州议会")
    .replace(/organizational and control/g, "组织和监督")
    .replace(/Economic Management/g, "经济管理")
    .replace(/Center for Development and Protection of Competition Policy/g, "竞争政策发展和保护中心")
    .replace(/Agency of the Republic of Kazakhstan for the Protection of Competition/g, "哈萨克斯坦共和国竞争保护署")
    .replace(/Investigation of Anticompetitive Actions of Government Agencies/g, "国家机关反竞争行为调查")
    .replace(/Investigation Department/g, "调查部门")
    .replace(/Interregional Inspectorate/g, "跨区域监察局")
    .replace(/Entrepreneurship and Industry/g, "创业和工业")
    .replace(/Agriculture/g, "农业")
    .replace(/Secretary of/g, "秘书")
    .replace(/Secretary/g, "秘书")
    .replace(/ - /g, " - ")
    .replace(/\s+区/g, "区")
    .replace(/\s+州/g, "州")
    .replace(/\s+乡区/g, "乡区")
    .replace(/阿科勒区区长/g, "阿科勒区区长")
    .replace(/布兰迪区的 区长/g, "布兰迪区区长")
    .replace(/阿尔沙雷区的 区长/g, "阿尔沙雷区区长")
    .replace(/扎尔凯恩斯基区区长/g, "扎尔凯恩区区长")
    .replace(/特纳/g, "车工")
    .replace(/NC KTZ 股份公司/g, "“哈萨克斯坦铁路”国家公司")
    .replace(/库斯塔奈/g, "科斯塔奈")
    .replace(/阿科勒\s+区/g, "阿科勒区")
    .replace(/布兰迪\s+区的\s+区长/g, "布兰迪区区长")
    .replace(/阿尔沙雷\s+区的\s+区长/g, "阿尔沙雷区区长")
    .replace(/副\s+区长/g, "副州长")
    .replace(/阿克莫拉地区/g, "阿克莫拉州")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text || TRANSLATION_PENDING_ZH;
}

async function translateStructuredBlocks(blocks, existingBlocks, sourceLanguage) {
  if (blockTranslationStillMatches(blocks, existingBlocks) && !blocksHaveBadChinese(existingBlocks)) return existingBlocks;
  const nodes = collectTextNodes(blocks);
  if (!nodes.length) return [];
  const existingNodes = collectTextNodes(existingBlocks || []);
  const values = nodes.map((node, index) => {
    const existing = existingNodes[index];
    return existing?.sourceText === node.text && existing.text && !hasBadChinese(existing.text) ? existing.text : "";
  });
  const pending = values.map((value, index) => (value ? -1 : index)).filter((index) => index !== -1);
  const chunks = [];
  const groups = [];
  pending.forEach((nodeIndex) => {
    splitForTranslation(nodes[nodeIndex].text).forEach((chunk) => {
      chunks.push(chunk);
      groups.push(nodeIndex);
    });
  });
  if (chunks.length) {
    const translatedChunks = await translateChunks(chunks, "auto");
    const grouped = nodes.map(() => []);
    translatedChunks.forEach((chunk, index) => grouped[groups[index]].push(chunk));
    pending.forEach((nodeIndex) => {
      const raw = grouped[nodeIndex].filter(Boolean).join("\n");
      let polished = polishChineseTranslation(raw, nodes[nodeIndex].text);
      if (hasBadChinese(polished)) polished = polishChineseTranslation(nodes[nodeIndex].text, nodes[nodeIndex].text);
      values[nodeIndex] = polished || TRANSLATION_PENDING_ZH;
    });
  }
  let index = 0;
  function clone(block) {
    if (!block || typeof block !== "object") return block;
    const next = { ...block };
    if (["heading", "paragraph", "link", "listItem", "cell"].includes(block.type)) {
      next.sourceText = block.text || "";
      next.text = block.text ? (values[index++] ?? TRANSLATION_PENDING_ZH) : "";
    }
    if (Array.isArray(block.items)) next.items = block.items.map(clone);
    if (Array.isArray(block.rows)) next.rows = block.rows.map((row) => row.map(clone));
    return next;
  }
  return blocks.map(clone);
}

function repairTranslatedBlocks(blocks = []) {
  function clone(block) {
    if (!block || typeof block !== "object") return block;
    const next = { ...block };
    if (["heading", "paragraph", "link", "listItem", "cell"].includes(block.type)) {
      if (hasBadChinese(next.text)) {
        const fixed = polishChineseTranslation(next.text, next.sourceText || "");
        next.text = hasBadChinese(fixed) ? polishChineseTranslation(next.sourceText || "", next.sourceText || "") : fixed;
      }
      if (!next.sourceText && next.text === TRANSLATION_PENDING_ZH) next.text = "";
    }
    if (Array.isArray(block.items)) next.items = block.items.map(clone);
    if (Array.isArray(block.rows)) next.rows = block.rows.map((row) => row.map(clone));
    return next;
  }
  return blocks.map(clone);
}

function translatePosition(position = "", region = {}) {
  const text = normalizeText(position);
  const lower = text.toLowerCase();
  const regionName = region.nameZh || "该州";
  if (!text) return "职务待同步";
  if (/уполномоченн.*этик|этик|әдеп/i.test(lower)) return "伦理专员";
  if (/ревизионн.*комисс/i.test(lower)) return "审计委员会主席";
  if (/государственн.*секрет|госсекрет/i.test(lower)) return "国家秘密保护负责人";
  if (/проектн.*офис/i.test(lower)) return "项目办公室负责人";
  if (/мобилизационн.*подготов|мобилизац/i.test(lower)) return "动员准备保障机构负责人";
  if (/аппарат басшысының орынбасары|басшысының орынбасары/i.test(lower)) return "办公室副主任";
  if (/и\.?\s*о\.?\s*руководител|исполняющ.*обязанност.*руководител|временно исполняющ/i.test(lower)) return "代理负责人";
  if (/director|директор/i.test(lower)) return "主任";
  if (/department head/i.test(lower)) return "部门负责人";
  if (/acting head/i.test(lower)) return "代理负责人";
  if (/chief agricultural officer/i.test(lower)) return "农业事务首席负责人";
  if (/first deputy/i.test(lower) || /первый заместитель/i.test(lower)) return `${regionName}第一副州长`;
  if (/deputy mayor|deputy akim|заместитель/i.test(lower)) return `${regionName}副州长`;
  if (/mayor of|akim of|аким/i.test(lower) && !/deputy|заместитель/i.test(lower)) return `${regionName}州长`;
  if (/head of apparatus|chief of staff|руководитель аппарата/i.test(lower)) return "办公室主任";
  if (/press secretary|пресс-секретарь/i.test(lower)) return "新闻秘书";
  if (/ethics commissioner/i.test(lower)) return "伦理专员";
  if (/documentation support and control/i.test(lower)) return "文书流转与监督部门负责人";
  if (/head of|руководитель|начальник/i.test(lower)) return "部门负责人";
  if (/chief inspector|главный инспектор|генеральный инспектор/i.test(lower)) return "首席监察员";
  if (/chief specialist|главный специалист/i.test(lower)) return "首席专家";
  if (/specialist|специалист/i.test(lower)) return "专家";
  if (/advisor|adviser|советник/i.test(lower)) return "顾问";
  return text;
}

function translateWorkScope(value = "") {
  const text = normalizeText(value);
  if (!text) return "官方页面未列出单独工作范围。";
  const dictionary = [
    [/эконом/i, "经济"],
    [/бюджет/i, "预算"],
    [/финанс/i, "财政"],
    [/государственн.*закуп/i, "政府采购"],
    [/коммунальн.*собственн|жилищн.*фонд/i, "市政资产和住房基金管理"],
    [/предпринимател/i, "企业事务"],
    [/туризм/i, "旅游"],
    [/инвест/i, "投资"],
    [/индустриально|ииновацион|инновацион/i, "工业和创新发展"],
    [/промышлен/i, "工业"],
    [/здравоохран/i, "医疗卫生"],
    [/социальн.*защит|занятост/i, "社会保障和就业"],
    [/строитель/i, "建设"],
    [/жилищно-коммунальн|жкх/i, "住房和公用事业"],
    [/энергет/i, "能源"],
    [/водоснабж/i, "供水"],
    [/теплоснабж/i, "供热"],
    [/газоснабж/i, "供气"],
    [/благоустрой|озелен/i, "城市美化和绿化"],
    [/пассажир|транспорт|автомобильн.*дорог/i, "交通和公路"],
    [/телекоммуникац/i, "电信"],
    [/градостроит|архитектур/i, "城市规划与建筑"],
    [/архитектурно-строительн.*контрол/i, "建筑工程监督"],
    [/сельск.*хозяй/i, "农业"],
    [/ветеринар/i, "兽医"],
    [/природн.*ресурс|природопольз/i, "自然资源与自然资源管理"],
    [/земельн.*отнош/i, "土地关系"],
    [/животновод/i, "畜牧业"],
    [/растениевод/i, "种植业"],
    [/рыболов/i, "渔业"],
    [/водн.*ресурс/i, "水资源"],
    [/внутренн.*полит/i, "内政政策"],
    [/культур/i, "文化"],
    [/информац/i, "信息"],
    [/архив/i, "档案"],
    [/образован/i, "教育"],
    [/наук/i, "科学"],
    [/спорт|физическ/i, "体育"],
    [/молодеж/i, "青年政策"],
    [/религи/i, "宗教"],
    [/развит.*язык/i, "语言发展"],
    [/цифров/i, "数字化"],
    [/мобилизац/i, "动员准备"],
    [/территориальн.*гражданск.*обор|гражданск.*обор/i, "国土和民防"],
    [/правопоряд/i, "法治秩序"],
    [/аппарат акима/i, "州长办公室"],
    [/государственн.*услуг/i, "政务服务"],
    [/противодейств.*корруп/i, "反腐败"],
    [/чс|чрезвычай/i, "应急事务"],
    [/общественн.*безопас/i, "公共安全"],
    [/пресс/i, "新闻发布"],
    [/проектн.*офис/i, "项目办公室"],
    [/документац|документооборот/i, "文书流转"],
    [/обращен/i, "信访办理"],
    [/антитеррорист/i, "反恐委员会工作"],
    [/правоохран/i, "执法机关协作"],
    [/мониторинг/i, "监测"],
    [/координирует|курирует/i, "协调和监督"],
    [/отдел/i, "部门"],
    [/Physical culture and sport/i, "体育和运动"],
    [/Industry and Business/i, "工业和商业"],
    [/^Industry$/i, "工业"],
    [/Land relations/i, "土地关系"],
    [/Entrepreneurship/i, "创业与企业事务"],
    [/transport/i, "交通"],
    [/housing|communal/i, "住房和公用事业"],
    [/construction|architecture/i, "建设与建筑"],
    [/education/i, "教育"],
    [/health/i, "医疗卫生"],
    [/finance|budget/i, "财政和预算"],
    [/econom/i, "经济"],
    [/social/i, "社会事务"],
    [/agriculture/i, "农业"],
    [/culture/i, "文化"],
    [/digital/i, "数字化"],
    [/Ecological situation/i, "生态环境"],
    [/Taza Kazakhstan/i, "“清洁哈萨克斯坦”项目"],
  ];
  const parts = text.split(/[\n,;、]+/).map((part) => part.trim()).filter(Boolean);
  return parts
    .map((part) => {
      const hit = dictionary.find(([regex]) => regex.test(part));
      if (hit) return hit[1];
      const polished = polishChineseTranslation(part, part);
      return /[\u0400-\u04ff]{2,}|[A-Za-z]{4,}/.test(polished) ? "相关工作事项" : polished;
    })
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join("、");
}

function personName(primary = {}, fallback = {}) {
  const lastname = normalizeText(primary.lastname || fallback.lastname || "");
  const name = normalizeText(primary.name || fallback.name || "");
  const middlename = normalizeText(primary.middlename || fallback.middlename || "");
  if (!lastname) return normalizeText([name, middlename].filter(Boolean).join(" "));
  if (lastname.split(/\s+/).length >= 3) return lastname;
  if ((name && lastname.includes(name)) || (middlename && lastname.includes(middlename))) return lastname;
  return normalizeText([lastname, name, middlename].filter(Boolean).join(" "));
}

function mapPerson(item, detail, region, sourceIndex) {
  const sourceLanguage = region.sourceLanguage || "en";
  const generalInfoHtml = detail?.biography || item.biography || "";
  const careerHistoryHtml = detail?.biography_details || item.biography_details || "";
  const levelPosition = normalizeText(item.level?.items?.[0]?.position || detail?.level?.items?.[0]?.position || "");
  const position = normalizeText(detail?.position || item.position || item.level?.items?.[0]?.position || "");
  const responsibilities = stripTags((detail?.cur_directions?.items || item.cur_directions?.items || []).map((entry) => entry.title || entry.name || "").join("\n"));
  return {
    id: item.id,
    name: personName(detail, item),
    nameZh: personName(detail, item),
    position,
    positionZh: translatePosition(position, region),
    responsibilities,
    workScopeZh: translateWorkScope(responsibilities),
    order: item.order ?? detail?.order ?? "",
    levelPosition,
    sourceIndex,
    photo: absoluteGovUrl(detail?.photo || item.photo || ""),
    phone: normalizeText(detail?.phone || detail?.phone_number || item.phone || item.phone_number || ""),
    receptionPhone: normalizeText(detail?.public_reception_phone || detail?.phone || item.public_reception_phone || item.phone || ""),
    email: normalizeText(detail?.email || item.email || ""),
    biographyUrl: `${GOV_BASE}/memleket/entities/${region.apiProject}/about/structure/people/${item.id}?lang=${sourceLanguage}`,
    generalInfoHtml,
    careerHistoryHtml,
    generalInfoBlocks: htmlToStructuredBlocks(generalInfoHtml),
    careerHistoryBlocks: htmlToStructuredBlocks(careerHistoryHtml),
    generalInfo: blocksToText(htmlToStructuredBlocks(generalInfoHtml)),
    careerHistory: blocksToText(htmlToStructuredBlocks(careerHistoryHtml)),
    translationSourceLanguage: sourceLanguage,
    translationNote: DISCLAIMER,
  };
}

async function mergeChinese(person, existingPeople, region) {
  const existing = existingPeople.find((item) => String(item.id) === String(person.id)) || {};
  const sourceLanguage = region.sourceLanguage || "en";
  const oldBlocksOk = existing.translationSourceLanguage === sourceLanguage;
  const generalInfoBlocksZh = repairTranslatedBlocks(await translateStructuredBlocks(person.generalInfoBlocks, oldBlocksOk ? existing.generalInfoBlocksZh : [], sourceLanguage));
  const careerHistoryBlocksZh = repairTranslatedBlocks(await translateStructuredBlocks(person.careerHistoryBlocks, oldBlocksOk ? existing.careerHistoryBlocksZh : [], sourceLanguage));
  return {
    ...person,
    generalInfoBlocksZh,
    careerHistoryBlocksZh,
    generalInfoZh: blocksToText(generalInfoBlocksZh),
    careerHistoryZh: blocksToText(careerHistoryBlocksZh),
    detailZh: [blocksToText(generalInfoBlocksZh), blocksToText(careerHistoryBlocksZh)].filter(Boolean).join("\n"),
  };
}

function sortPeople(a, b) {
  return (a.sourceIndex || 0) - (b.sourceIndex || 0);
}

function numericOrder(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : 9999;
}

function hierarchyRank(person) {
  const text = (person.levelPosition || person.position || "").toLowerCase();
  if (/\b(akim|mayor)\b|аким|әкім/.test(text) && !/deputy|заместител|орынбасар/.test(text)) return 10;
  if (/\bfirst\s+deputy\b|перв(ый|ого)\s+замест|бірінші\s+орынбасар/.test(text)) return 20;
  if (/\bdeputy\s+(akim|mayor)\b|заместител|орынбасар/.test(text)) return 30;
  if (/head\s+of\s+apparatus|chief\s+of\s+staff|руководитель\s+аппарата|аппарат\s+басшысы/.test(text)) return 40;
  if (/deputy\s+chief\s+of\s+staff|deputy\s+head\s+of\s+the\s+akim|заместител.*руководител.*аппарата/.test(text)) return 50;
  if (/ethics\s+commissioner|этика|әдеп/.test(text)) return 60;
  if (/department\s+head|head\s+of\s+the|head\s+of\s+department|руководител|басшысы|chief\s+inspector/.test(text)) return 70;
  if (/press|пресс|баспасөз/.test(text)) return 80;
  return 90;
}

function sortPeopleForRegion(people, region) {
  if (region.sortMode === "source") return people.slice().sort(sortPeople);
  return people.slice().sort((a, b) => (
    hierarchyRank(a) - hierarchyRank(b) ||
    numericOrder(a.order) - numericOrder(b.order) ||
    (a.sourceIndex || 0) - (b.sourceIndex || 0)
  ));
}

function dedupePeopleForRegion(people, region) {
  if (region.dedupePeople === false) return people;
  const seen = new Set();
  return people.filter((person) => {
    const key = [
      normalizeText(person.name).toLowerCase(),
      normalizeText(person.position).toLowerCase(),
      normalizeText(person.phone || person.receptionPhone).toLowerCase(),
      normalizeText(person.email).toLowerCase(),
      normalizeText(person.photo).toLowerCase(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildContentBlocks(region, people) {
  return [
    { type: "heading", level: 1, text: `${region.nameZh}机构人员` },
    ...people.map((person) => ({ type: "person", id: person.id, name: person.name, position: person.position, positionZh: person.positionZh, photo: person.photo })),
  ];
}

function assertStablePeople(people) {
  const emptyNames = people.filter((person) => !person.name);
  if (emptyNames.length) {
    throw new Error(`Empty official names: ${emptyNames.map((person) => person.id).join(", ")}`);
  }
}

async function fetchJson(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; SilkRoadInfoSync/2.0)", "accept-language": options.language || "en", ...(options.headers || {}) } });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  throw lastError;
}

function collectionItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.content)) return payload.content;
  return [];
}

async function syncRegion(region) {
  const language = region.sourceLanguage || "en";
  const url = `${GOV_BASE}/api/v1/public/content-manager/curators?projects=${encodeURIComponent(region.apiProject)}&size=100`;
  const payload = await fetchJson(url, { language });
  const items = collectionItems(payload);
  const outputPath = path.join(ROOT, "data", `${region.key}-people.json`);
  const existingData = readJson(outputPath, { people: [] });
  const people = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const detailUrl = `${GOV_BASE}/api/v1/public/content-manager/curators/${item.id}`;
    let detail = null;
    try {
      detail = await fetchJson(detailUrl, { language }, 2);
    } catch {
      detail = item;
    }
    const person = mapPerson(item, detail, region, index);
    people.push(await mergeChinese(person, existingData.people || [], region));
  }
  const uniquePeople = dedupePeopleForRegion(people, region);
  const sortedPeople = sortPeopleForRegion(uniquePeople, region);
  assertStablePeople(sortedPeople);
  const data = {
    sourceUrl: region.sourceUrl,
    syncedAt: beijingMidnightIso(),
    title: `${region.nameZh}机构人员`,
    region: { key: region.key, apiProject: region.apiProject, sourceLanguage: language },
    contentBlocks: buildContentBlocks(region, sortedPeople),
    people: sortedPeople,
    translationNote: DISCLAIMER,
  };
  writeJson(outputPath, data);
  console.log(`${region.key}: ${sortedPeople.length} people`);
}

async function main() {
  const regions = readJson(CONFIG_PATH, []);
  const requested = process.argv.slice(2);
  const selected = requested.length ? regions.filter((region) => requested.includes(region.key)) : regions;
  if (!selected.length) throw new Error(`No matching region: ${requested.join(", ")}`);
  for (const region of selected) await syncRegion(region);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
