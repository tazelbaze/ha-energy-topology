const ESC = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));

const TIER_LABEL = (tier) => ({ 1: "Primaire", 2: "Secondaire", 3: "Tertiaire" }[tier] || `Niveau ${tier}`);

class EnergyTopologyPanel extends HTMLElement {
  set hass(value) {
    this._hass = value;
    if (!this._loaded) this._load();
  }

  set panel(value) { this._panel = value; }

  connectedCallback() {
    this.innerHTML = `<style>${this._styles()}</style><main><div class="loading">Chargement de la topologie…</div></main>`;
  }

  async _load() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      const result = await this._hass.callWS({ type: "energy_topology/get" });
      this._nodes = this._indexNodes(result.nodes || []);
      this._issues = result.issues || [];
      this._loaded = true;
      this._render();
    } catch (err) {
      this.innerHTML = `<style>${this._styles()}</style><main><div class="error">Impossible de lire la topologie (energy_topology/get) : ${ESC(err?.message || err)}</div></main>`;
    } finally {
      this._loading = false;
    }
  }

  _indexNodes(list) {
    const nodes = new Map();
    for (const item of list) {
      nodes.set(item.id, { ...item, children: [] });
    }
    for (const node of nodes.values()) {
      if (node.parent_id && nodes.has(node.parent_id)) {
        nodes.get(node.parent_id).children.push(node);
      }
    }
    return nodes;
  }

  _roots() {
    return [...this._nodes.values()].filter((n) => !n.parent_id || !this._nodes.has(n.parent_id));
  }

  _location(node) {
    if (node.floor_name && node.area_name) return `${node.floor_name} · ${node.area_name}`;
    if (node.area_name) return node.area_name;
    if (node.floor_name) return node.floor_name;
    return "non localisé";
  }

  _renderNode(node, ancestry = new Set()) {
    if (ancestry.has(node.id)) return `<li class="cycle">Cycle vers ${ESC(node.name)}</li>`;
    const next = new Set(ancestry); next.add(node.id);
    const errors = this._issues.filter((i) => i.node === node.id && i.severity === "error").length;
    const badge = errors ? `<span class="badge error-badge">${errors}</span>` : `<span class="badge ok-badge">OK</span>`;
    const children = [...node.children].sort((a, b) => a.name.localeCompare(b.name));

    let head;
    if (node.is_panel) {
      const rooms = (node.rooms || []).map((r) => `<span class="chip room">${ESC(r)}</span>`).join("");
      head = `
        <span class="tier tier-${node.tier}">${ESC(TIER_LABEL(node.tier))}</span>
        <span class="node-name panel-name">${ESC(node.name)}</span>
        <code>${ESC(node.id)}</code>
        ${rooms || ""}
        ${node.parent_id ? `<span class="parent">inclus dans ${ESC(node.parent_id)}</span>` : `<span class="root">racine</span>`}
        ${badge}`;
    } else {
      const located = node.area_name || node.floor_name;
      head = `
        <span class="node-name">${ESC(node.name)}</span>
        <code>${ESC(node.id)}</code>
        <span class="loc ${located ? "" : "loc-none"}">${ESC(this._location(node))}</span>
        ${node.parent_id ? `<span class="parent">inclus dans ${ESC(node.parent_id)}</span>` : `<span class="root">racine</span>`}
        ${badge}`;
    }

    return `<li class="${node.is_panel ? "is-panel" : ""}">
      <details open>
        <summary>${head}</summary>
        ${children.length ? `<ul>${children.map((c) => this._renderNode(c, next)).join("")}</ul>` : ""}
      </details>
    </li>`;
  }

  _render() {
    const nodes = [...this._nodes.values()];
    const roots = this._roots();
    const panels = nodes.filter((n) => n.is_panel).length;
    const located = nodes.filter((n) => n.area_name || n.floor_name).length;
    const errors = this._issues.filter((i) => i.severity === "error");

    const issueBlock = errors.length
      ? `<section class="issues">
          <h2>Anomalies</h2>
          ${errors.map((i) => `<div class="issue"><span class="pill error">erreur</span><strong>${ESC(i.node)}</strong> — ${ESC(i.message)}</div>`).join("")}
        </section>`
      : `<section class="success">Aucune boucle, parent absent ni auto-référence détectés.</section>`;

    this.innerHTML = `<style>${this._styles()}</style>
      <main>
        <header>
          <div><h1>Topologie des tableaux et appareils</h1><p>Vue lecture seule. Les nœuds agrégateurs sont vos <strong>tableaux/zones</strong> (<code>included_in_stat</code>), les pièces sont dérivées du registre.</p></div>
          <button id="refresh">Actualiser</button>
        </header>
        <section class="metrics">
          <article><strong>${nodes.length}</strong><span>appareils</span></article>
          <article><strong>${panels}</strong><span>tableaux</span></article>
          <article><strong>${roots.length}</strong><span>racines</span></article>
          <article><strong>${located}/${nodes.length}</strong><span>localisés</span></article>
          <article class="${errors.length ? "metric-error" : ""}"><strong>${errors.length}</strong><span>erreurs</span></article>
        </section>
        <section class="toolbar"><input id="search" type="search" placeholder="Rechercher un appareil, un statistic_id, une pièce…"></section>
        ${issueBlock}
        <section class="tree"><ul>${roots.sort((a, b) => a.name.localeCompare(b.name)).map((r) => this._renderNode(r)).join("")}</ul></section>
      </main>`;
    this.querySelector("#refresh").addEventListener("click", () => { this._loaded = false; this._load(); });
    this.querySelector("#search").addEventListener("input", (event) => this._filter(event.target.value));
  }

  _filter(query) {
    const q = query.trim().toLowerCase();
    for (const li of this.querySelectorAll(".tree li")) {
      li.hidden = Boolean(q) && !li.textContent.toLowerCase().includes(q);
    }
  }

  _styles() { return `
    :host{display:block;background:var(--primary-background-color);color:var(--primary-text-color);min-height:100%;font-family:var(--paper-font-body1_-_font-family,system-ui)}
    main{max-width:1200px;margin:auto;padding:24px} header{display:flex;justify-content:space-between;gap:16px;align-items:center} h1{margin:0;font-size:26px} h2{font-size:18px} p{color:var(--secondary-text-color)}
    button,input{font:inherit;border:1px solid var(--divider-color);border-radius:10px;padding:10px 14px;background:var(--card-background-color);color:inherit} button{cursor:pointer;background:var(--primary-color);color:var(--text-primary-color)}
    .metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:20px 0}.metrics article{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px;display:flex;flex-direction:column}.metrics strong{font-size:24px}.metrics span{color:var(--secondary-text-color);font-size:13px}
    .metric-error{border-color:var(--error-color)!important}.toolbar input{width:100%;box-sizing:border-box}
    .issues,.success,.tree{margin-top:16px;background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px}.success{border-color:var(--success-color)}
    .issue{display:flex;align-items:center;gap:8px;padding:4px 0}.pill{font-size:11px;border-radius:999px;padding:2px 8px;text-transform:uppercase;letter-spacing:.03em}.pill.error{background:rgba(220,50,50,.18);color:var(--error-color)}
    ul{list-style:none;margin:0;padding-left:22px}.tree>ul{padding-left:0}li{margin:6px 0}summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap;cursor:pointer;padding:8px;border-radius:8px}summary:hover{background:var(--secondary-background-color)}
    li.is-panel>details>summary{background:var(--secondary-background-color);border:1px solid var(--divider-color)}
    .node-name{font-weight:600}.panel-name{font-weight:700}code{font-size:12px;color:var(--secondary-text-color)}.parent,.root{font-size:12px;color:var(--secondary-text-color)}
    .tier{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:6px;padding:2px 8px;background:var(--primary-color);color:var(--text-primary-color)}
    .tier-2{background:var(--accent-color,#3f7fd0)}.tier-3{background:var(--state-icon-active-color,#7a52c7)}
    .chip{font-size:12px;border-radius:999px;padding:1px 8px}.chip.room{border:1px solid var(--divider-color);color:var(--secondary-text-color)}
    .loc{font-size:12px;border:1px solid var(--divider-color);border-radius:999px;padding:1px 8px;color:var(--secondary-text-color)}.loc-none{opacity:.6;font-style:italic}
    .badge{font-size:11px;border-radius:999px;padding:2px 7px;margin-left:auto}.ok-badge{background:rgba(30,160,90,.15)}.error-badge{background:rgba(220,50,50,.2);color:var(--error-color)}.cycle{color:var(--error-color)}.error{padding:24px;color:var(--error-color)}
    @media(max-width:900px){.metrics{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:700px){main{padding:14px}.metrics{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}summary .badge{margin-left:0}}
  `; }
}
customElements.define("energy-topology-panel", EnergyTopologyPanel);
