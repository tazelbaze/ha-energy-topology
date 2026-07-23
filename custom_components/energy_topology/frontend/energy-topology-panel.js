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
    this.innerHTML = `<style>${this._styles()}</style><main><div class="loading">Chargement de la configuration Énergie…</div></main>`;
  }

  async _load() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    try {
      const prefs = await this._hass.callWS({ type: "energy/get_prefs" });
      this._prefs = prefs;
      this._nodes = this._buildNodes(prefs.device_consumption || []);
      this._issues = this._validate(this._nodes);
      this._loaded = true;
      this._render();
    } catch (err) {
      this.innerHTML = `<style>${this._styles()}</style><main><div class="error">Impossible de lire energy/get_prefs : ${ESC(err?.message || err)}</div></main>`;
    } finally {
      this._loading = false;
    }
  }

  _buildNodes(items) {
    const nodes = new Map();
    for (const item of items) {
      nodes.set(item.stat_consumption, {
        id: item.stat_consumption,
        name: item.name || this._friendlyName(item.stat_consumption),
        parentId: item.included_in_stat || null,
        rateId: item.stat_rate || null,
        children: []
      });
    }
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).children.push(node);
    }
    return nodes;
  }

  _friendlyName(statId) {
    const state = this._hass.states?.[statId];
    return state?.attributes?.friendly_name || statId;
  }

  _validate(nodes) {
    const issues = [];
    for (const node of nodes.values()) {
      if (node.parentId && !nodes.has(node.parentId)) {
        issues.push({ severity: "error", node: node.id, message: `Parent introuvable : ${node.parentId}` });
      }
      if (node.parentId === node.id) {
        issues.push({ severity: "error", node: node.id, message: "Un appareil ne peut pas être son propre parent." });
      }
    }

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const colors = new Map([...nodes.keys()].map((id) => [id, WHITE]));
    const stack = [];
    const visit = (id) => {
      colors.set(id, GRAY); stack.push(id);
      const parent = nodes.get(id)?.parentId;
      if (parent && nodes.has(parent)) {
        if (colors.get(parent) === GRAY) {
          const start = stack.indexOf(parent);
          issues.push({ severity: "error", node: id, message: `Cycle détecté : ${stack.slice(start).concat(parent).join(" → ")}` });
        } else if (colors.get(parent) === WHITE) visit(parent);
      }
      stack.pop(); colors.set(id, BLACK);
    };
    for (const id of nodes.keys()) if (colors.get(id) === WHITE) visit(id);
    return issues;
  }

  _roots() {
    return [...this._nodes.values()].filter((n) => !n.parentId || !this._nodes.has(n.parentId));
  }

  _renderNode(node, depth = 0, ancestry = new Set()) {
    if (ancestry.has(node.id)) return `<li class="cycle">Cycle vers ${ESC(node.name)}</li>`;
    const next = new Set(ancestry); next.add(node.id);
    const issueCount = this._issues.filter((i) => i.node === node.id).length;
    return `<li>
      <details open>
        <summary>
          <span class="node-name">${ESC(node.name)}</span>
          <code>${ESC(node.id)}</code>
          ${node.parentId ? `<span class="parent">inclus dans ${ESC(node.parentId)}</span>` : `<span class="root">racine</span>`}
          ${issueCount ? `<span class="badge error-badge">${issueCount}</span>` : `<span class="badge ok-badge">OK</span>`}
        </summary>
        ${node.children.length ? `<ul>${node.children.sort((a,b)=>a.name.localeCompare(b.name)).map((c)=>this._renderNode(c, depth+1, next)).join("")}</ul>` : ""}
      </details>
    </li>`;
  }

  _render() {
    const nodes = [...this._nodes.values()];
    const roots = this._roots();
    const parented = nodes.filter((n) => n.parentId).length;
    this.innerHTML = `<style>${this._styles()}</style>
      <main>
        <header>
          <div><h1>Topologie des appareils individuels</h1><p>Vue en lecture seule des relations <code>included_in_stat</code>.</p></div>
          <button id="refresh">Actualiser</button>
        </header>
        <section class="metrics">
          <article><strong>${nodes.length}</strong><span>appareils</span></article>
          <article><strong>${parented}</strong><span>relations upstream</span></article>
          <article><strong>${roots.length}</strong><span>racines</span></article>
          <article class="${this._issues.length ? "metric-error" : ""}"><strong>${this._issues.length}</strong><span>anomalies</span></article>
        </section>
        <section class="toolbar"><input id="search" type="search" placeholder="Rechercher un appareil ou un statistic_id…"></section>
        ${this._issues.length ? `<section class="issues"><h2>Anomalies</h2>${this._issues.map(i=>`<div><strong>${ESC(i.node)}</strong> — ${ESC(i.message)}</div>`).join("")}</section>` : `<section class="success">Aucune boucle ni référence de parent absente détectée.</section>`}
        <section class="tree"><ul>${roots.sort((a,b)=>a.name.localeCompare(b.name)).map((r)=>this._renderNode(r)).join("")}</ul></section>
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
    .metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.metrics article{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px;display:flex;flex-direction:column}.metrics strong{font-size:28px}.metrics span{color:var(--secondary-text-color)}
    .metric-error{border-color:var(--error-color)!important}.toolbar input{width:100%;box-sizing:border-box}.issues,.success,.tree{margin-top:16px;background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:12px;padding:16px}.issues{border-color:var(--error-color)}.success{border-color:var(--success-color)}
    ul{list-style:none;margin:0;padding-left:22px}.tree>ul{padding-left:0}li{margin:6px 0}summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap;cursor:pointer;padding:8px;border-radius:8px}summary:hover{background:var(--secondary-background-color)}.node-name{font-weight:600}code{font-size:12px;color:var(--secondary-text-color)}.parent,.root{font-size:12px;color:var(--secondary-text-color)}.badge{font-size:11px;border-radius:999px;padding:2px 7px}.ok-badge{background:rgba(30,160,90,.15)}.error-badge{background:rgba(220,50,50,.2);color:var(--error-color)}.cycle{color:var(--error-color)}.error{padding:24px;color:var(--error-color)}
    @media(max-width:700px){main{padding:14px}.metrics{grid-template-columns:repeat(2,1fr)}header{align-items:flex-start;flex-direction:column}}
  `; }
}
customElements.define("energy-topology-panel", EnergyTopologyPanel);
