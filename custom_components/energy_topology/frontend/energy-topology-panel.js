const ESC = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
}[char]));

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
    const nodeIssues = this._issues.filter((i) => i.node === node.id);
    const errors = nodeIssues.filter((i) => i.severity === "error").length;
    const warnings = nodeIssues.filter((i) => i.severity === "warning").length;
    const located = node.area_name || node.floor_name;
    const badge = errors
      ? `<span class="badge error-badge">${errors}</span>`
      : warnings
        ? `<span class="badge warn-badge">${warnings}</span>`
        : `<span class="badge ok-badge">OK</span>`;
    const children = [...node.children].sort((a, b) => a.name.localeCompare(b.name));
    return `<li>
      <details open>
        <summary>
          <span class="node-name">${ESC(node.name)}</span>
          <code>${ESC(node.id)}</code>
          <span class="loc ${located ? "" : "loc-none"}">${ESC(this._location(node))}</span>
          ${node.parent_id ? `<span class="parent">inclus dans ${ESC(node.parent_id)}</span>` : `<span class="root">racine</span>`}
          ${badge}
        </summary>
        ${children.length ? `<ul>${children.map((c) => this._renderNode(c, next)).join("")}</ul>` : ""}
      </details>
    </li>`;
  }

  _render() {
    const nodes = [...this._nodes.values()];
    const roots = this._roots();
    const parented = nodes.filter((n) => n.parent_id && this._nodes.has(n.parent_id)).length;
    const errors = this._issues.filter((i) => i.severity === "error");
    const warnings = this._issues.filter((i) => i.severity === "warning");
    const located = nodes.filter((n) => n.area_name || n.floor_name).length;

    const issueBlock = this._issues.length
      ? `<section class="issues">
          <h2>Anomalies</h2>
          ${this._issues.map((i) => `<div class="issue ${i.severity}"><span class="pill ${i.severity}">${i.severity === "error" ? "erreur" : "alerte"}</span><strong>${ESC(i.node)}</strong> — ${ESC(i.message)}</div>`).join("")}
        </section>`
      : `<section class="success">Aucune boucle, parent absent ou rattachement inter-pièces détecté.</section>`;

    this.innerHTML = `<style>${this._styles()}</style>
      <main>
        <header>
          <div><h1>Topologie des appareils individuels</h1><p>Vue lecture seule des relations <code>included_in_stat</code>, enrichie par pièce et étage.</p></div>
          <button id="refresh">Actualiser</button>
        </header>
        <section class="metrics">
          <article><strong>${nodes.length}</strong><span>appareils</span></article>
          <article><strong>${parented}</strong><span>relations upstream</span></article>
          <article><strong>${roots.length}</strong><span>racines</span></article>
          <article><strong>${located}/${nodes.length}</strong><span>localisés</span></article>
          <article class="${errors.length ? "metric-error" : ""}"><strong>${errors.length}</strong><span>erreurs</span></article>
          <article class="${warnings.length ? "metric-warn" : ""}"><strong>${warnings.length}</strong><span>alertes</span></article>
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
    .metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:20px 0}.metrics article{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px;display:flex;flex-direction:column}.metrics strong{font-size:24px}.metrics span{color:var(--secondary-text-color);font-size:13px}
    .metric-error{border-color:var(--error-color)!important}.metric-warn{border-color:var(--warning-color,#e0a400)!important}.toolbar input{width:100%;box-sizing:border-box}
    .issues,.success,.tree{margin-top:16px;background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px}.success{border-color:var(--success-color)}
    .issue{display:flex;align-items:center;gap:8px;padding:4px 0}.pill{font-size:11px;border-radius:999px;padding:2px 8px;text-transform:uppercase;letter-spacing:.03em}.pill.error{background:rgba(220,50,50,.18);color:var(--error-color)}.pill.warning{background:rgba(224,164,0,.2);color:var(--warning-color,#b7860b)}
    ul{list-style:none;margin:0;padding-left:22px}.tree>ul{padding-left:0}li{margin:6px 0}summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap;cursor:pointer;padding:8px;border-radius:8px}summary:hover{background:var(--secondary-background-color)}.node-name{font-weight:600}code{font-size:12px;color:var(--secondary-text-color)}
    .parent,.root{font-size:12px;color:var(--secondary-text-color)}.loc{font-size:12px;border:1px solid var(--divider-color);border-radius:999px;padding:1px 8px;color:var(--secondary-text-color)}.loc-none{opacity:.6;font-style:italic}
    .badge{font-size:11px;border-radius:999px;padding:2px 7px;margin-left:auto}.ok-badge{background:rgba(30,160,90,.15)}.warn-badge{background:rgba(224,164,0,.2);color:var(--warning-color,#b7860b)}.error-badge{background:rgba(220,50,50,.2);color:var(--error-color)}.cycle{color:var(--error-color)}.error{padding:24px;color:var(--error-color)}
    @media(max-width:900px){.metrics{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:700px){main{padding:14px}.metrics{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}summary .badge{margin-left:0}}
  `; }
}
customElements.define("energy-topology-panel", EnergyTopologyPanel);
