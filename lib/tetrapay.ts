import { fetchWithTimeout } from "./bot.js";

const API_KEY = "7c557272bdd58727996fbba2dd8339b1";

export async function createTetrapayOrder(params: {
  purchaseId: string;
  amountToman: number;
  description: string;
  callbackUrl: string;
}) {
  const payload = {
    ApiKey: API_KEY,
    Hash_id: params.purchaseId,
    Amount: params.amountToman,
    Description: params.description,
    Email: "customer@example.com",
    Mobile: "09120000000",
    CallbackURL: params.callbackUrl
  };

  const res = await fetchWithTimeout("https://tetra98.com/api/create_order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TetraPay create order failed to parse: ${raw}`);
  }

  if (data.status == 100 || data.status == "100") {
    return {
      ok: true,
      authority: data.Authority,
      paymentUrlBot: data.payment_url_bot,
      paymentUrlWeb: data.payment_url_web,
      trackingId: data.tracking_id
    };
  } else {
    return {
      ok: false,
      message: `TetraPay error: ${data.status} - ${raw}`
    };
  }
}

export async function verifyTetrapayOrder(authority: string) {
  const payload = {
    authority,
    ApiKey: API_KEY
  };

  const res = await fetchWithTimeout("https://tetra98.com/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TetraPay verify failed to parse: ${raw}`);
  }

  // Assuming status 100 is success based on typical Iranian gateways
  if (data.status == 100 || data.status == "100") {
    return { ok: true, data };
  } else {
    return { ok: false, message: `TetraPay verify error: ${data.status} - ${raw}`, data };
  }
}
