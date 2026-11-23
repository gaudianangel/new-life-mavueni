
const https = require("https");

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let body = "";

      res.on("data", chunk => body += chunk);

      res.on("end", () => {
        let result = {};

        try {
          result = body ? JSON.parse(body) : {};
        } catch {
          return reject(new Error("Invalid server response."));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(
            result?.errorMessage ||
            result?.message ||
            result?.error ||
            `Request failed with HTTP ${res.statusCode}.`
          ));
        }

        resolve(result);
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("Request timed out."));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

async function updateOrder(url, key, id, values) {
  return requestJson(
    `${url}/rest/v1/orders?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(values)
    }
  );
}

function getKenyaTimestamp() {
  const kenyaTime = new Date(Date.now() + 3 * 60 * 60 * 1000);

  return kenyaTime
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  let orderId = null;
  let supabaseUrl = "";
  let secretKey = "";
  let stage = "checking configuration";

  try {
    const {
      MPESA_CONSUMER_KEY,
      MPESA_CONSUMER_SECRET,
      MPESA_SHORTCODE,
      MPESA_TILL_NUMBER,
      MPESA_PASSKEY,
      MPESA_CALLBACK_URL,
      SUPABASE_URL,
      SUPABASE_SECRET_KEY
    } = process.env;

    if (
      !MPESA_CONSUMER_KEY ||
      !MPESA_CONSUMER_SECRET ||
      !MPESA_SHORTCODE ||
      !MPESA_TILL_NUMBER ||
      !MPESA_PASSKEY ||
      !MPESA_CALLBACK_URL
    ) {
      throw new Error("M-PESA production environment variables are missing.");
    }

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      throw new Error("Supabase environment variables are missing.");
    }

    if (
      !/^\d{4,7}$/.test(MPESA_SHORTCODE.trim()) ||
      !/^\d{4,7}$/.test(MPESA_TILL_NUMBER.trim())
    ) {
      throw new Error("Invalid M-PESA Store Number or Till Number.");
    }

    if (!MPESA_CALLBACK_URL.startsWith("https://")) {
      throw new Error("A public HTTPS callback URL is required.");
    }

    supabaseUrl = SUPABASE_URL.trim().replace(/\/+$/, "");
    secretKey = SUPABASE_SECRET_KEY;

    const data = JSON.parse(event.body || "{}");

    const name = String(data.name || "").trim().slice(0, 100);

    if (!name) {
      throw new Error("Please enter your name.");
    }

    let phone = String(data.phone || "").replace(/\s+/g, "");

    if (/^0[17]\d{8}$/.test(phone)) {
      phone = "254" + phone.substring(1);
    }

    if (/^\+254[17]\d{8}$/.test(phone)) {
      phone = phone.substring(1);
    }

    if (!/^254[17]\d{8}$/.test(phone)) {
      throw new Error("Enter a valid Kenyan M-PESA number.");
    }

    const products = {
      water_500ml: {
        price: 500,
        name: "500ml Living Water"
      },
      water_1l: {
        price: 1000,
        name: "1L Living Water"
      },
      prayer_request: {
        price: 700,
        name: "Prayer Request"
      },
      support_choir: {
        price: 200,
        name: "Choir Support"
      }
    };

    const item = products[data.product];

    if (!item) {
      throw new Error("Invalid payment option.");
    }

    const quantity = Number(data.quantity || 1);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20 ||
      (!["water_500ml", "water_1l"].includes(data.product) &&
        quantity !== 1)
    ) {
      throw new Error("Invalid quantity.");
    }

    const amount = item.price * quantity;

    const location = String(data.location || "")
      .trim()
      .slice(0, 300);

    const prayer = String(data.prayer || "")
      .trim()
      .slice(0, 2000);

    if (
      ["water_500ml", "water_1l"].includes(data.product) &&
      !location
    ) {
      throw new Error(
        "Please enter your delivery or collection location."
      );
    }

    if (data.product === "prayer_request" && !prayer) {
      throw new Error("Please enter your prayer request.");
    }

    // SAVE ORDER TO SUPABASE

    stage = "saving order to Supabase";

    const savedOrders = await requestJson(
      `${supabaseUrl}/rest/v1/orders`,
      {
        method: "POST",
        headers: {
          apikey: secretKey,
          Authorization: "Bearer " + secretKey,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          customer_name: name,
          customer_phone: phone,
          product: data.product,
          quantity,
          amount,
          delivery_location: location || null,
          prayer_request: prayer || null,
          payment_status: "pending"
        })
      }
    );

    if (!Array.isArray(savedOrders) || !savedOrders[0]?.id) {
      throw new Error("The order could not be saved.");
    }

    orderId = savedOrders[0].id;

    // LIVE DARAJA ACCESS TOKEN

    stage = "requesting production Daraja access token";

    const auth = Buffer.from(
      MPESA_CONSUMER_KEY + ":" + MPESA_CONSUMER_SECRET
    ).toString("base64");

    const tokenData = await requestJson(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        method: "GET",
        headers: {
          Authorization: "Basic " + auth
        }
      }
    );

    if (!tokenData.access_token) {
      throw new Error("Daraja did not return an access token.");
    }

    // GENERATE STK PASSWORD

    stage = "generating M-PESA password";

    const shortcode = MPESA_SHORTCODE.trim();
    const tillNumber = MPESA_TILL_NUMBER.trim();

    const timestamp = getKenyaTimestamp();

    const password = Buffer.from(
      shortcode + MPESA_PASSKEY + timestamp
    ).toString("base64");

    // LIVE BUY GOODS STK PUSH

    stage = "sending live Buy Goods STK Push";

    const payment = await requestJson(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokenData.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerBuyGoodsOnline",
          Amount: amount,
          PartyA: phone,
          PartyB: tillNumber,
          PhoneNumber: phone,
          CallBackURL: MPESA_CALLBACK_URL,
          AccountReference: "NEWLIFE",
          TransactionDesc: item.name.substring(0, 13)
        })
      }
    );

    if (
      payment.ResponseCode &&
      String(payment.ResponseCode) !== "0"
    ) {
      throw new Error(
        payment.ResponseDescription ||
        "M-PESA did not accept the payment request."
      );
    }

    if (!payment.CheckoutRequestID) {
      throw new Error(
        payment.errorMessage ||
        "Daraja did not return a Checkout Request ID."
      );
    }

    // SAVE PAYMENT REQUEST IDS

    stage = "saving payment request IDs";

    await updateOrder(
      supabaseUrl,
      secretKey,
      orderId,
      {
        checkout_request_id: payment.CheckoutRequestID,
        merchant_request_id: payment.MerchantRequestID || null
      }
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: payment.CustomerMessage ||
          "M-PESA payment prompt sent successfully.",
        checkoutRequestID: payment.CheckoutRequestID,
        merchantRequestID: payment.MerchantRequestID,
        amount,
        item: item.name
      })
    };

  } catch (error) {
    console.error(
      "M-PESA STK error:",
      stage,
      error.message
    );

    if (orderId && supabaseUrl && secretKey) {
      try {
        await updateOrder(
          supabaseUrl,
          secretKey,
          orderId,
          {
            payment_status: "failed"
          }
        );
      } catch (updateError) {
        console.error(
          "Order update error:",
          updateError.message
        );
      }
    }

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        error: error.message ||
          "Unable to process payment.",
        stage
      })
    };
  }
};
