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

  function formatDate(value) {
    if (!value) return "暂无更新时间";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `更新于 ${date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} 00:00`;
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

  function renderPerson(person) {
    const photo = person.photo
      ? `<img src="${escapeHtml(person.photo)}" alt="${escapeHtml(person.name)}" loading="lazy" />`
      : `<span>${escapeHtml(initials(person.name))}</span>`;
    const personKey = person.id || slugify(person.name);
    const detailUrl = `region-biography.html?region=${encodeURIComponent(regionKey)}&id=${encodeURIComponent(personKey)}`;
    const workScope = person.workScopeZh
      ? `
          <div>
            <dt>工作范围</dt>
            <dd>${escapeHtml(person.workScopeZh)}</dd>
          </div>`
      : "";

    return `
      <article class="person-card">
        <div class="person-photo">${photo}</div>
        <div class="person-body">
          <h3>${escapeHtml(person.name || person.nameZh || "姓名待同步")}</h3>
          <dl class="field-list">
            <div>
              <dt>职务</dt>
              <dd>${escapeHtml(person.positionZh || person.position || "等待官方页面同步")}</dd>
            </div>
            ${workScope}
            <div>
              <dt><a href="${detailUrl}">人员履历</a></dt>
              <dd><a href="${detailUrl}">查看人员履历</a></dd>
            </div>
            <div>
              <dt>联系方式</dt>
              <dd>${escapeHtml([person.receptionPhone || person.phone, person.email].filter(Boolean).join(" / ") || "暂无")}</dd>
            </div>
          </dl>
        </div>
      </article>
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
      document.title = `${region.nameZh}机构人员 | 丝路译讯`;
      document.getElementById("region-eyebrow").textContent = region.eyebrow || "Local Government";
      document.getElementById("region-title").textContent = `${region.nameZh}机构人员`;
      document.getElementById("source-link").innerHTML = `本页面内容翻译自原网站，中文翻译仅供参考。来源：<a href="${escapeHtml(region.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(region.sourceUrl)}</a>`;

      const data = await loadData(region);
      const people = Array.isArray(data.people) ? data.people : [];
      document.getElementById("sync-time").textContent = formatDate(data.syncedAt);
      document.getElementById("people-grid").innerHTML =
        people.length > 0
          ? people.map(renderPerson).join("")
          : '<p class="empty-state">暂无人员数据，等待自动同步。</p>';
    })
    .catch(() => {
      document.getElementById("people-grid").innerHTML =
        '<p class="empty-state">数据读取失败，请稍后再试。</p>';
    });
})();
