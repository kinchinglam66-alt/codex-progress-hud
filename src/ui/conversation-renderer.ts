import type { ConversationView } from "./view-model.js";

/** Keyed nodes preserve scrolling and identity; host titles are always text. */
export function createConversationRenderer(container: HTMLElement) {
  const document = container.ownerDocument;
  const entries = new Map<string, {
    root: HTMLElement; title: HTMLElement; status: HTMLElement;
    bar: HTMLElement; fill: HTMLElement; percent: HTMLElement; eta: HTMLElement;
    freshness:HTMLElement;details:HTMLDetailsElement;diagnostic:HTMLElement;
  }>();
  return (views: readonly ConversationView[]): void => {
    const keys = new Set(views.map(view => view.key));
    for (const [key, entry] of entries) {
      if (!keys.has(key)) { entry.root.remove(); entries.delete(key); }
    }
    views.forEach((view, index) => {
      let entry = entries.get(view.key);
      if (!entry) {
        const root = document.createElement("section");
        root.className = "conversation-row";
        const title = document.createElement("h2");
        title.className = "conversation-title";
        const status = document.createElement("span");
        status.className = "conversation-status";
        const progress = document.createElement("div");
        progress.className = "progress-row";
        const bar = document.createElement("div");
        bar.className = "progress";
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        const fill = document.createElement("span");
        fill.className = "progress-fill";
        bar.append(fill);
        const percent = document.createElement("span");
        percent.className = "progress-text";
        progress.append(bar, percent);
        const eta = document.createElement("p");
        eta.className = "eta";
        const freshness=document.createElement('p');freshness.className='estimate-freshness';
        const details=document.createElement('details');details.className='observer-diagnostics';
        const summary=document.createElement('summary');summary.textContent='估时诊断';
        const diagnostic=document.createElement('p');details.append(summary,diagnostic);
        root.append(title, status, progress, eta, freshness, details);
        entry = { root, title, status, bar, fill, percent, eta, freshness, details, diagnostic };
        entries.set(view.key, entry);
      }
      entry.root.dataset.tone = view.tone;
      entry.title.textContent = view.title;
      entry.title.title = view.title;
      entry.status.textContent = view.statusLabel + (view.nameFreshness === "stale" ? " · 名称待同步" : "");
      entry.bar.setAttribute("aria-label", view.title + " · 任务进度");
      entry.bar.dataset.mode = view.progressMode;
      if (view.progressPercent === null) entry.bar.removeAttribute("aria-valuenow");
      else entry.bar.setAttribute("aria-valuenow", String(view.progressPercent));
      entry.fill.style.width = String(view.progressPercent ?? 34) + "%";
      entry.percent.textContent = view.progressPercent === null ? "" : String(view.progressPercent) + "%";
      entry.eta.textContent = view.etaLabel;
      entry.freshness.textContent=view.freshnessLabel??'';
      entry.freshness.hidden=!view.freshnessLabel;
      entry.details.hidden=!view.diagnosticLabel;
      entry.diagnostic.textContent=view.diagnosticLabel??'';
      if (container.children[index] !== entry.root) {
        container.insertBefore(entry.root, container.children[index] ?? null);
      }
    });
  };
}
