(() => {
  const params = new URLSearchParams(location.search);
  const regionKey = params.get("region") || "aqmola";

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function initials(name) {
    return String(name || "KZ")
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function paragraphs(value) {
    return String(value || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("");
  }

  function splitStaffSection(value, headingPattern) {
    const lines = String(value || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const index = lines.findIndex((line) => headingPattern.test(line));
    if (index === -1) return { text: value, rows: [] };

    return {
      text: lines.slice(0, index).join("\n"),
      rows: parseStaffRows(lines.slice(index + 1)),
    };
  }

  function isPhoneLine(value) {
    return /^[+\d][\d\s()/-]{3,}$/.test(String(value || "").trim());
  }

  function isStaffRole(value) {
    return /^(chief|head|leading|senior|main|principal|specialist|inspector|expert|consultant|advisor|manager|director|assistant|首席|主管|主任|高级|领先|专家|监察员|总督察|首席专家督察)/i.test(
      String(value || "").trim()
    );
  }

  function translateStaffRole(value) {
    const text = String(value || "").trim();
    const lower = text.toLowerCase();
    if (!text) return "暂无";
    if (lower.includes("chief specialist-inspector")) return "首席专家-监察员";
    if (lower.includes("chief inspector")) return "首席监察员";
    if (lower.includes("chief specialist")) return "首席专家";
    if (lower.includes("head specialist")) return "主管专家";
    if (lower.includes("leading specialist")) return "主任专家";
    if (lower.includes("senior specialist")) return "高级专家";
    if (lower.includes("specialist")) return "专家";
    if (lower.includes("inspector")) return "监察员";
    return text;
  }

  function parseStaffRows(lines) {
    const rows = [];
    let current = null;

    for (const line of lines) {
      if (isStaffRole(line)) {
        if (current) rows.push(current);
        current = { role: line, name: "", phone: "" };
        continue;
      }

      if (!current) current = { role: "", name: "", phone: "" };

      if (isPhoneLine(line)) {
        current.phone = current.phone ? `${current.phone} / ${line}` : line;
      } else if (!current.name) {
        current.name = line;
      } else {
        current.name = `${current.name} ${line}`;
      }
    }

    if (current) rows.push(current);
    return rows.filter((row) => row.role || row.name || row.phone);
  }

  function renderStaffTable(rows, language) {
    if (!rows.length) return "";
    const isChinese = language === "zh";
    return `
      <div class="biography-table-wrap">
        <table class="biography-table">
          <thead>
            <tr>
              <th>${isChinese ? "职务" : "Position"}</th>
              <th>${isChinese ? "姓名" : "Name"}</th>
              <th>${isChinese ? "电话" : "Phone"}</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <td>${escapeHtml(isChinese ? translateStaffRole(row.role) : row.role || "-")}</td>
                    <td>${escapeHtml(row.name || "-")}</td>
                    <td>${escapeHtml(row.phone || "-")}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function isDateLine(value) {
    return /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[-年]|from|since|present|current|currently|to date|now|自|至今|目前)/i.test(
      String(value || "").trim()
    );
  }

  function parseInlinePeriod(line) {
    const text = String(line || "").trim();
    const slashMatch = text.match(/^(.{6,80}?\d{2,4})\s*\/\s*(.+)$/);
    if (slashMatch) return { period: slashMatch[1].trim(), description: slashMatch[2].trim() };

    const zhMatch = text.match(/^(.{4,60}?(?:至|起|以来|至今|—|-).{0,40}?)(?:，|,|任|在)(.+)$/);
    if (zhMatch && /\d/.test(zhMatch[1])) {
      return { period: zhMatch[1].trim(), description: `${text.includes("任") ? "任" : ""}${zhMatch[2].trim()}` };
    }

    const enMatch = text.match(/^(.{6,80}?(?:-|–|—|to).{2,40}?)\s+(.+)$/i);
    if (enMatch && /\d/.test(enMatch[1])) {
      return { period: enMatch[1].trim(), description: enMatch[2].trim() };
    }

    return null;
  }

  function parseTimelineRows(value) {
    const lines = String(value || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const rows = [];

    for (let index = 0; index < lines.length; index += 1) {
      const inline = parseInlinePeriod(lines[index]);
      if (inline) {
        rows.push(inline);
        continue;
      }

      if (isDateLine(lines[index]) && isDateLine(lines[index + 1]) && lines[index + 2]) {
        rows.push({
          period: `${lines[index]} - ${lines[index + 1]}`,
          description: lines[index + 2],
        });
        index += 2;
        continue;
      }
    }

    return rows.length >= 3 ? rows : [];
  }

  function renderTimelineTable(rows, language) {
    if (!rows.length) return "";
    const isChinese = language === "zh";
    return `
      <div class="biography-table-wrap">
        <table class="biography-table biography-timeline-table">
          <thead>
            <tr>
              <th>${isChinese ? "时间" : "Period"}</th>
              <th>${isChinese ? "履历内容" : "Career record"}</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
                  <tr>
                    <td>${escapeHtml(row.period || "-")}</td>
                    <td>${escapeHtml(row.description || "-")}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderOfficialTables(tables, language) {
    if (!Array.isArray(tables) || !tables.length) return "";
    const isChinese = language === "zh";

    return tables
      .map((table) => {
        const rows = Array.isArray(table) ? table.filter((row) => Array.isArray(row) && row.some(Boolean)) : [];
        if (!rows.length) return "";
        const columnCount = Math.max(...rows.map((row) => row.length));
        const firstRow = rows[0];
        const firstRowText = firstRow.join(" ").toLowerCase();
        const hasHeader =
          /^(position|name|phone|职位|职务|姓名|电话|字段)/i.test(firstRowText) ||
          (firstRowText.includes("position") && firstRowText.includes("name"));
        const head = hasHeader ? firstRow : [];
        const body = hasHeader ? rows.slice(1) : rows;

        return `
          <div class="biography-table-wrap">
            <table class="biography-table">
              ${
                head.length
                  ? `<thead><tr>${head.map((cell) => `<th>${escapeHtml(cell || "-")}</th>`).join("")}</tr></thead>`
                  : ""
              }
              <tbody>
                ${body
                  .map(
                    (row) => `
                      <tr>
                        ${Array.from({ length: columnCount }, (_, index) => `<td>${escapeHtml(row[index] || "-")}</td>`).join("")}
                      </tr>
                    `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        `;
      })
      .join("");
  }

  function renderStructuredTable(rows) {
    const normalizedRows = Array.isArray(rows)
      ? rows.filter((row) => Array.isArray(row) && row.some((cell) => cell?.text || cell?.links?.length))
      : [];
    if (!normalizedRows.length) return "";

    const columnCount = Math.max(...normalizedRows.map((row) => row.length));
    const firstRow = normalizedRows[0];
    const firstRowText = firstRow.map((cell) => cell?.text || "").join(" ").toLowerCase();
    const hasHeader =
      firstRow.some((cell) => cell?.header) ||
      /^(position|name|phone|职位|职务|姓名|电话|字段)/i.test(firstRowText) ||
      (firstRowText.includes("position") && firstRowText.includes("name"));
    const head = hasHeader ? firstRow : [];
    const body = hasHeader ? normalizedRows.slice(1) : normalizedRows;

    return `
      <div class="biography-table-wrap">
        <table class="biography-table">
          ${
            head.length
              ? `<thead><tr>${head.map((cell) => `<th>${escapeHtml(cell?.text || "-")}</th>`).join("")}</tr></thead>`
              : ""
          }
          <tbody>
            ${body
              .map(
                (row) => `
                  <tr>
                    ${Array.from({ length: columnCount }, (_, index) => `<td>${escapeHtml(row[index]?.text || "-")}</td>`).join("")}
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderStructuredBlocks(blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return "";

    return blocks
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        if (block.type === "heading") {
          const level = Math.min(Math.max(Number(block.level) || 3, 3), 5);
          return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
        }
        if (block.type === "paragraph") {
          return `<p>${escapeHtml(block.text)}</p>`;
        }
        if (block.type === "list") {
          const tag = block.ordered ? "ol" : "ul";
          return `<${tag}>${(block.items || []).map((item) => `<li>${escapeHtml(item.text)}</li>`).join("")}</${tag}>`;
        }
        if (block.type === "table") {
          return renderStructuredTable(block.rows);
        }
        if (block.type === "link") {
          return `<p><a href="${escapeHtml(block.href)}" target="_blank" rel="noreferrer">${escapeHtml(block.text || block.href)}</a></p>`;
        }
        if (block.type === "image") {
          return `<figure><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt || "")}" loading="lazy" /></figure>`;
        }
        return "";
      })
      .join("");
  }

  function mergeTimelineRows(rows, fallbackRows = []) {
    if (!fallbackRows.length) return rows;
    return fallbackRows.map((fallback, index) => {
      const row = rows[index] || {};
      return {
        period: fallback.period || row.period || "-",
        description: row.description || fallback.description || "详见官方原文",
      };
    });
  }

  function renderTextBlock(title, value, options = {}) {
    const structured = renderStructuredBlocks(options.blocks);
    if (structured) {
      return `
        <article class="biography-text-card">
          <h3>${escapeHtml(title)}</h3>
          ${structured}
        </article>
      `;
    }

    const section = options.staffPattern ? splitStaffSection(value, options.staffPattern) : { text: value, rows: [] };
    const rows = options.fallbackRows
      ? Array.from({ length: Math.max(section.rows.length, options.fallbackRows.length) }, (_, index) => {
          const row = section.rows[index] || {};
          const fallback = options.fallbackRows[index] || {};
          return {
            role: row.role || fallback.role || "",
            name: row.name || fallback.name || "",
            phone: fallback.phone || row.phone || "",
          };
        })
      : section.rows;
    const officialTables = Array.isArray(options.tables) ? options.tables : [];
    const fallbackTimelineRows = options.fallbackTimelineValue ? parseTimelineRows(options.fallbackTimelineValue) : [];
    const timelineRows = rows.length || officialTables.length ? [] : mergeTimelineRows(parseTimelineRows(section.text), fallbackTimelineRows);
    return `
      <article class="biography-text-card">
        <h3>${escapeHtml(title)}</h3>
        ${timelineRows.length ? "" : paragraphs(section.text || "暂无官方同步内容")}
        ${renderOfficialTables(officialTables, options.language)}
        ${rows.length ? `<h4>${escapeHtml(options.staffTitle || "Department staff")}</h4>` : ""}
        ${renderStaffTable(rows, options.language)}
        ${renderTimelineTable(timelineRows, options.language)}
      </article>
    `;
  }

  function renderPerson(person, region) {
    const photo = person.photo
      ? `<img src="${escapeHtml(person.photo)}" alt="${escapeHtml(person.name)}" loading="lazy" />`
      : `<span>${escapeHtml(initials(person.name))}</span>`;
    const displayName = person.name || person.nameZh;
    const displayPosition = person.positionZh || person.position || "职务待同步";
    const sourceUrl = person.biographyUrl || region.sourceUrl;
    const originalStaffRows = splitStaffSection(person.careerHistory, /^Department staff[:：]?$/i).rows;

    document.getElementById("source-note").innerHTML = `
      本页面内容翻译自原网站，中文翻译仅供参考。来源：
      <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(sourceUrl)}</a>
    `;

    return `
      <div class="biography-profile-card">
        <div class="biography-photo">${photo}</div>
        <div class="biography-profile-main">
          <p class="eyebrow">Personnel Biography</p>
          <h1>${escapeHtml(displayName)}</h1>
          <dl class="biography-meta">
            <div>
              <dt>原文姓名</dt>
              <dd>${escapeHtml(person.name || "暂无")}</dd>
            </div>
            <div>
              <dt>职务</dt>
              <dd>${escapeHtml(displayPosition)}</dd>
            </div>
            <div>
              <dt>原文职务</dt>
              <dd>${escapeHtml(person.position || "暂无")}</dd>
            </div>
            <div>
              <dt>联系方式</dt>
              <dd>${escapeHtml([person.receptionPhone || person.phone, person.email].filter(Boolean).join(" / ") || "暂无")}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div class="biography-card-grid">
        ${renderTextBlock("中文译文：基本信息与教育背景", person.generalInfoZh || person.detailZh, {
          blocks: person.generalInfoBlocksZh,
        })}
        ${renderTextBlock("中文译文：工作履历", person.careerHistoryZh || person.detailZh, {
          blocks: person.careerHistoryBlocksZh,
          staffPattern: /^部门人员[:：]?$/,
          staffTitle: "部门人员",
          language: "zh",
          fallbackRows: originalStaffRows,
          fallbackTimelineValue: person.careerHistory,
        })}
        ${renderTextBlock("Official Original: General information, education", person.generalInfo, {
          blocks: person.generalInfoBlocks,
        })}
        ${renderTextBlock("Official Original: Career", person.careerHistory, {
          blocks: person.careerHistoryBlocks,
          staffPattern: /^Department staff[:：]?$/i,
          staffTitle: "Department staff",
          language: "en",
          tables: person.careerHistoryTables,
        })}
      </div>
    `;
  }

  async function loadRegionConfig() {
    const response = await fetch("data/regions-index.json", { cache: "no-store" });
    if (!response.ok) throw new Error(response.statusText);
    const regions = await response.json();
    return regions.find((region) => region.key === regionKey) || regions[0];
  }

  async function loadData(region) {
    const response = await fetch(`data/${region.key}-people.json`, { cache: "no-store" });
    if (!response.ok) throw new Error(response.statusText);
    return response.json();
  }

  loadRegionConfig()
    .then(async (region) => {
      const data = await loadData(region);
      const people = Array.isArray(data.people) ? data.people : [];
      const selectedId = params.get("id");
      const person =
        people.find((item) => String(item.id || "") === selectedId) ||
        people.find((item) => slugify(item.name) === selectedId) ||
        people[0];
      document.title = `${person?.name || person?.nameZh || "人员履历"} | 丝路译讯`;
      document.getElementById("biography-shell").innerHTML = person
        ? renderPerson(person, region)
        : '<p class="empty-state">暂无人员履历数据，等待自动同步。</p>';
    })
    .catch(() => {
      document.getElementById("biography-shell").innerHTML =
        '<p class="empty-state">数据读取失败，请稍后再试。</p>';
    });
})();
