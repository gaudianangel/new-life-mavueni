
const https = require("https");

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let body = "";

      res.on("data", chunk => body += chunk);

      res.on("end", () => {
        let result = null;

        if (body) {
          try {
            result = JSON.parse(body);
          } catch {
            return reject(new Error("Invalid Supabase response."));
          }
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(
            result?.message || "Supabase request failed."
          ));
        }

        resolve(result);
      });
    });

    req.on("error", reject);

    if (options.body) req.write(options.body);

    req.end();
  });
}

function getMetadataValue(items, name) {
  const item = items.find(entry => entry.Name === name);
  return item ? item.Value : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      throw new Error("Supabase environment variables are missing.");
    }

    const callback = JSON.parse(event.body || "{}");

    console.log(
      "NEW LIFE MAVUENI MPESA CALLBACK:",
      JSON.stringify(callback)
    );

    const stkCallback = callback?.Body?.stkCallback;

    if (!stkCallback) {
      throw new Error("Invalid M-PESA callback structure.");
    }

    const checkoutRequestID = stkCallback.CheckoutRequestID;

    if (!checkoutRequestID) {
      throw new Error("Checkout Request ID is missing.");
    }

    const resultCode = String(stkCallback.ResultCode);
    const resultDescription = String(
      stkCallback.ResultDesc || "No payment description provided."
    ).slice(0, 500);

    const supabaseUrl = SUPABASE_URL.replace(/\/+$/, "");
    const headers = {
      "apikey": SUPABASE_SECRET_KEY,
      "Authorization": "Bearer " + SUPABASE_SECRET_KEY,
      "Content-Type": "application/json"
    };

    // Find the matching order.
    const orders = await requestJson(
      `${supabaseUrl}/rest/v1/orders?checkout_request_id=eq.${encodeURIComponent(checkoutRequestID)}&select=id,amount,customer_phone`,
      {
        method: "GET",
        headers
      }
    );

    if (!Array.isArray(orders) || orders.length === 0) {
      console.error("No order found for:", checkoutRequestID);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ResultCode: 0,
          ResultDesc: "Callback received; no matching order found."
        })
      };
    }

    const order = orders[0];

    const update = {
      payment_status: resultCode === "0" ? "paid" : "failed",
      mpesa_result_code: resultCode,
      mpesa_result_description: resultDescription,
      updated_at: new Date().toISOString()
    };

    // Record details only when Safaricom reports success.
    if (resultCode === "0") {
      const metadata = stkCallback.CallbackMetadata?.Item || [];

      const paidAmount = Number(
        getMetadataValue(metadata, "Amount")
      );

      const receipt = getMetadataValue(
        metadata,
        "MpesaReceiptNumber"
      );

      const paidPhone = String(
        getMetadataValue(metadata, "PhoneNumber") || ""
      );

      // Check the amount and phone against the saved order.
      if (
        !Number.isFinite(paidAmount) ||
        paidAmount !== Number(order.amount) ||
        paidPhone !== String(order.customer_phone) ||
        !receipt
      ) {
        console.error("Payment details did not match order:", order.id);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ResultCode: 0,
            ResultDesc: "Callback received; payment requires verification."
          })
        };
      }

      update.mpesa_receipt = String(receipt);
    }

    // Update the order in Supabase.
    await requestJson(
      `${supabaseUrl}/rest/v1/orders?id=eq.${order.id}`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Prefer": "return=minimal"
        },
        body: JSON.stringify(update)
      }
    );

    console.log(
      "New Life Mavueni order updated:",
      order.id,
      update.payment_status
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ResultCode: 0,
        ResultDesc: "Accepted"
      })
    };

  } catch (error) {
    console.error("M-PESA callback error:", error.message);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Callback processing failed."
      })
    };
  }
};
