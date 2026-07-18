(() => {
  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function paragraphs(value) {
    return String(value || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("");
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

  window.BiographyFormat = {
    renderTextBlock(title, value, options = {}) {
      const fallbackRows = options.fallbackValue ? parseTimelineRows(options.fallbackValue) : [];
      const timelineRows = mergeTimelineRows(parseTimelineRows(value), fallbackRows);
      return `
        <article class="biography-text-card">
          <h3>${escapeHtml(title)}</h3>
          ${timelineRows.length ? "" : paragraphs(value || "暂无官方同步内容")}
          ${renderTimelineTable(timelineRows, options.language)}
        </article>
      `;
    },
    parseTimelineRows,
  };
})();
