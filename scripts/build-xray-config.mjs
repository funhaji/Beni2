#!/usr/bin/env node
/**
 * Build proxy/xray-config.json from SOCKS5 URL, share link, subscription, or full JSON.
 * Usage: V2RAY_INPUT="vless://..." node scripts/build-xray-config.mjs
 *        node scripts/build-xray-config.mjs /path/to/input.txt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "proxy");
const OUT_FILE = path.join(OUT_DIR, "xray-config.json");

function readInput() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) {
    return fs.readFileSync(arg, "utf8").trim();
  }
  if (process.env.V2RAY_INPUT?.trim()) {
    return process.env.V2RAY_INPUT.trim();
  }
  throw new Error("Set V2RAY_INPUT or pass a file path with v2ray/xray config or share link");
}

function decodeVmess(link) {
  const raw = link.replace(/^vmess:\/\//i, "");
  const json = Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(json);
}

function parseQuery(qs) {
  const params = new URLSearchParams(qs);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function buildStreamSettings(network, security, q) {
  const stream = { network: network || "tcp" };
  const sec = (security || q.security || q.type || "").toLowerCase();
  if (sec === "reality") {
    stream.security = "reality";
    stream.realitySettings = {
      serverName: q.sni || q.host || "",
      fingerprint: q.fp || "chrome",
      publicKey: q.pbk || q.publicKey || "",
      shortId: q.sid || q.shortId || "",
      spiderX: q.spx || "/"
    };
  } else if (sec === "tls" || q.tls === "tls" || q.security === "tls") {
    stream.security = "tls";
    stream.tlsSettings = {
      serverName: q.sni || q.host || "",
      fingerprint: q.fp || "",
      alpn: q.alpn ? q.alpn.split(",") : undefined,
      allowInsecure: q.allowInsecure === "1" || q.insecure === "1"
    };
  }
  if (stream.network === "ws") {
    stream.wsSettings = {
      path: q.path || "/",
      headers: q.host ? { Host: q.host } : {}
    };
  } else if (stream.network === "grpc") {
    stream.grpcSettings = {
      serviceName: q.serviceName || q.path || "",
      multiMode: q.mode === "multi"
    };
  } else if (stream.network === "tcp" && q.headerType === "http") {
    stream.tcpSettings = {
      header: {
        type: "http",
        request: {
          headers: { Host: (q.host || "").split(",") }
        }
      }
    };
  }
  return stream;
}

function outboundFromVless(link) {
  const u = new URL(link);
  const q = parseQuery(u.search.replace(/^\?/, ""));
  const uuid = decodeURIComponent(u.username);
  const address = u.hostname;
  const port = Number(u.port || 443);
  const network = q.type || "tcp";
  const flow = q.flow || "";
  const user = { id: uuid, encryption: q.encryption || "none" };
  if (flow) user.flow = flow;
  return {
    tag: "proxy",
    protocol: "vless",
    settings: {
      vnext: [{ address, port, users: [user] }]
    },
    streamSettings: buildStreamSettings(network, q.security, q)
  };
}

function outboundFromVmess(link) {
  const j = decodeVmess(link);
  const network = j.net || j.network || "tcp";
  const tls = j.tls === "tls" || j.tls === true;
  const user = {
    id: j.id,
    alterId: Number(j.aid || j.alterId || 0),
    security: j.scy || "auto"
  };
  const streamSettings = buildStreamSettings(network, tls ? "tls" : "", {
    sni: j.sni || j.host,
    host: j.host,
    path: j.path,
    fp: j.fp,
    type: j.type,
    security: tls ? "tls" : ""
  });
  return {
    tag: "proxy",
    protocol: "vmess",
    settings: {
      vnext: [
        {
          address: j.add || j.address,
          port: Number(j.port),
          users: [user]
        }
      ]
    },
    streamSettings
  };
}

function outboundFromTrojan(link) {
  const u = new URL(link);
  const q = parseQuery(u.search.replace(/^\?/, ""));
  const password = decodeURIComponent(u.username);
  return {
    tag: "proxy",
    protocol: "trojan",
    settings: {
      servers: [
        {
          address: u.hostname,
          port: Number(u.port || 443),
          password
        }
      ]
    },
    streamSettings: buildStreamSettings(q.type || "tcp", q.security || "tls", q)
  };
}

function outboundFromShadowsocks(link) {
  const u = new URL(link);
  const q = parseQuery(u.search.replace(/^\?/, ""));
  const method = u.username;
  const password = decodeURIComponent(u.password);
  return {
    tag: "proxy",
    protocol: "shadowsocks",
    settings: {
      servers: [
        {
          address: u.hostname,
          port: Number(u.port),
          method,
          password,
          ...(q.plugin ? { plugin: q.plugin } : {})
        }
      ]
    }
  };
}

function parseShareLink(line) {
  const link = line.trim();
  if (link.startsWith("vless://")) return outboundFromVless(link);
  if (link.startsWith("vmess://")) return outboundFromVmess(link);
  if (link.startsWith("trojan://")) return outboundFromTrojan(link);
  if (link.startsWith("ss://")) return outboundFromShadowsocks(link);
  throw new Error(`Unsupported share link: ${link.slice(0, 32)}...`);
}

async function fetchSubscription(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`subscription_http_${res.status}`);
  let body = (await res.text()).trim();
  try {
    body = Buffer.from(body, "base64").toString("utf8");
  } catch {
    /* plain text */
  }
  const line = body.split(/\r?\n/).find((l) => /^(vless|vmess|trojan|ss):\/\//i.test(l.trim()));
  if (!line) throw new Error("subscription_has_no_supported_links");
  return parseShareLink(line);
}

function extractProxyOutbound(parsed) {
  if (parsed.outbounds && Array.isArray(parsed.outbounds)) {
    const tagged =
      parsed.outbounds.find((o) => o.tag === "proxy") ||
      parsed.outbounds.find((o) => o.protocol && o.protocol !== "freedom" && o.protocol !== "blackhole");
    if (tagged) {
      return { ...tagged, tag: "proxy" };
    }
  }
  if (parsed.protocol && parsed.protocol !== "freedom") {
    return { ...parsed, tag: "proxy" };
  }
  throw new Error("JSON config has no proxy outbound");
}

function wrapConfig(proxyOutbound) {
  return {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "socks-in",
        listen: "0.0.0.0",
        port: 10808,
        protocol: "socks",
        settings: { auth: "noauth", udp: true }
      }
    ],
    outbounds: [
      proxyOutbound,
      { tag: "direct", protocol: "freedom", settings: {} },
      { tag: "block", protocol: "blackhole", settings: {} }
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        {
          type: "field",
          outboundTag: "direct",
          domain: ["geosite:private", "geosite:ir"]
        },
        {
          type: "field",
          outboundTag: "direct",
          ip: ["geoip:private", "geoip:ir"]
        },
        {
          type: "field",
          outboundTag: "proxy",
          network: "tcp,udp"
        }
      ]
    }
  };
}

async function main() {
  const input = readInput();
  let proxyOutbound;

  if (input.startsWith("{")) {
    proxyOutbound = extractProxyOutbound(JSON.parse(input));
  } else if (/^https?:\/\//i.test(input)) {
    proxyOutbound = await fetchSubscription(input);
  } else if (/^(vless|vmess|trojan|ss):\/\//i.test(input)) {
    proxyOutbound = parseShareLink(input);
  } else {
    throw new Error("Input must be JSON, subscription URL, or vless/vmess/trojan/ss link");
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const config = wrapConfig(proxyOutbound);
  fs.writeFileSync(OUT_FILE, JSON.stringify(config, null, 2));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
