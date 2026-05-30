(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let lookupData = null;
  let panels = [];

  // ── Restore token from localStorage ──────────────────────────────────────
  const tokenInput = $("tokenInput");
  tokenInput.value = localStorage.getItem("adminToken") || "";
  tokenInput.addEventListener("change", () => {
    localStorage.setItem("adminToken", tokenInput.value.trim());
  });

  function getToken() {
    const t = tokenInput.value.trim();
    localStorage.setItem("adminToken", t);
    return t;
  }

  function setStatus(el, msg, type) {
    el.textContent = msg;
    el.className = "status-msg " + (type || "");
  }

  function showSpinner(btn, label) {
    btn.disabled = true;
    btn.innerHTML = label + '<span class="spinner"></span>';
  }

  function restoreBtn(btn, label) {
    btn.disabled = false;
    btn.textContent = label;
  }

  // ── Load panels on page load ──────────────────────────────────────────────
  async function loadPanels(token) {
    if (!token) return;
    try {
      const r = await fetch("/api/migrate?token=" + encodeURIComponent(token));
      const d = await r.json();
      if (!d.ok) return;
      panels = d.panels || [];
      const sel = $("targetPanel");
      sel.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "— pick a target panel —";
      sel.appendChild(empty);
      panels.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.panel_type})`;
        sel.appendChild(opt);
      });
    } catch (e) {
      console.error("loadPanels:", e);
    }
  }

  // Auto-load if token already in localStorage
  if (tokenInput.value) loadPanels(tokenInput.value);
  tokenInput.addEventListener("blur", () => {
    if (tokenInput.value.trim()) loadPanels(tokenInput.value.trim());
  });

  // ── Lookup ────────────────────────────────────────────────────────────────
  $("btnLookup").addEventListener("click", async () => {
    const token = getToken();
    const subLink = $("subLinkInput").value.trim();
    const statusEl = $("lookupStatus");

    if (!token) { setStatus(statusEl, "⚠️ Enter your admin token first.", "err"); return; }
    if (!subLink) { setStatus(statusEl, "⚠️ Enter a sub link or identifier.", "err"); return; }

    showSpinner($("btnLookup"), "🔍 Lookup Config");
    setStatus(statusEl, "", "");
    $("infoBox").classList.remove("visible");
    $("step2").style.display = "none";
    $("step2Divider").style.display = "none";
    $("migrateActions").style.display = "none";
    $("resultBox").classList.remove("visible");
    lookupData = null;

    try {
      const r = await fetch("/api/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "lookup", subLink })
      });
      const d = await r.json();
      if (!d.ok) {
        setStatus(statusEl, "❌ " + (d.error || "Not found"), "err");
        restoreBtn($("btnLookup"), "🔍 Lookup Config");
        return;
      }

      lookupData = d;
      $("iSourcePanel").textContent = d.sourcePanelName || "—";
      $("iSourceType").textContent = d.sourcePanelType || "—";
      $("iSourceKey").textContent = d.sourceUserKey || "—";
      $("iRemaining").textContent = d.remainingLabel || "unlimited";
      $("iExpiry").textContent = d.expiryLabel || "unlimited";
      $("infoBox").classList.add("visible");
      $("step2").style.display = "block";
      $("step2Divider").style.display = "block";
      $("migrateActions").style.display = "block";
      setStatus(statusEl, "✅ Config found.", "ok");

      if (!panels.length) await loadPanels(token);
    } catch (e) {
      setStatus(statusEl, "❌ Network error: " + e.message, "err");
    }
    restoreBtn($("btnLookup"), "🔍 Lookup Config");
  });

  // ── Provision ─────────────────────────────────────────────────────────────
  $("btnMigrate").addEventListener("click", async () => {
    const token = getToken();
    const subLink = $("subLinkInput").value.trim();
    const targetPanelId = $("targetPanel").value;
    const statusEl = $("migrateStatus");

    if (!lookupData) { setStatus(statusEl, "⚠️ Run Lookup first.", "err"); return; }
    if (!targetPanelId) { setStatus(statusEl, "⚠️ Select a target panel.", "err"); return; }

    showSpinner($("btnMigrate"), "🚀 Migrate Config");
    setStatus(statusEl, "", "");
    $("resultBox").classList.remove("visible");

    try {
      const r = await fetch("/api/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "provision", subLink, targetPanelId: Number(targetPanelId) })
      });
      const d = await r.json();
      if (!d.ok) {
        setStatus(statusEl, "❌ " + (d.error || "Provision failed"), "err");
        restoreBtn($("btnMigrate"), "🚀 Migrate Config");
        return;
      }

      $("rUsername").textContent = d.username || "—";

      const subSection = $("rSubSection");
      const subUrlEl = $("rSubUrl");
      if (d.subscriptionUrl) {
        subUrlEl.textContent = d.subscriptionUrl;
        subSection.style.display = "block";
      } else {
        subSection.style.display = "none";
      }

      const linksList = $("rLinksList");
      linksList.innerHTML = "";
      const linksSection = $("rLinksSection");
      if (d.links && d.links.length) {
        d.links.forEach((link, i) => {
          const row = document.createElement("div");
          row.style.cssText = "display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px";
          const linkEl = document.createElement("div");
          linkEl.className = "result-link";
          linkEl.style.flex = "1";
          linkEl.id = "rLink_" + i;
          linkEl.textContent = link;
          const copyBtn = document.createElement("button");
          copyBtn.className = "btn copy-btn";
          copyBtn.textContent = "Copy";
          copyBtn.addEventListener("click", () => copyText(link, copyBtn));
          row.appendChild(linkEl);
          row.appendChild(copyBtn);
          linksList.appendChild(row);
        });
        linksSection.style.display = "block";
      } else {
        linksSection.style.display = "none";
      }

      $("resultBox").classList.add("visible");
      setStatus(statusEl,
        `✅ Migrated from ${d.sourcePanelName} → ${d.targetPanelName}  |  Data: ${d.remainingLabel}  |  Expiry: ${d.expiryLabel}`,
        "ok"
      );
    } catch (e) {
      setStatus(statusEl, "❌ Network error: " + e.message, "err");
    }
    restoreBtn($("btnMigrate"), "🚀 Migrate Config");
  });

  // ── Copy helper ───────────────────────────────────────────────────────────
  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const prev = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    }).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
  }

  // Copy buttons via data-copy attribute
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-copy");
      const el = document.getElementById(targetId);
      if (el) copyText(el.textContent.trim(), btn);
    });
  });
})();
