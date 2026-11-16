
const https = require("https");

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      let body = "";

      res.on("data", chunk => body += chunk);

      res.on("end", () => {
        let result;

        try {
          result = JSON.parse(body);
        } catch {
          return reject(new Error("Invalid Daraja response"));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(
            result.errorMessage || "Daraja request failed"
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

exports.handler = async (event) => {

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({error:"Method not allowed"})
    };
  }

  try {

    const {
      MPESA_CONSUMER_KEY,
      MPESA_CONSUMER_SECRET,
      MPESA_SHORTCODE,
      MPESA_PASSKEY,
      MPESA_CALLBACK_URL
    } = process.env;

    if (!MPESA_CONSUMER_KEY ||
        !MPESA_CONSUMER_SECRET ||
        !MPESA_SHORTCODE ||
        !MPESA_PASSKEY ||
        !MPESA_CALLBACK_URL) {

      throw new Error("M-Pesa environment variables are missing.");
    }

    const data = JSON.parse(event.body || "{}");

    const phone = String(data.phone || "");
    const amount = Number(data.amount);
    const quantity = Number(data.quantity);

    if (!/^254[17]\d{8}$/.test(phone)) {
      throw new Error("Invalid Kenyan phone number.");
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20 ||
      amount !== quantity * 1000
    ) {
      throw new Error("Invalid order amount.");
    }

    const auth = Buffer.from(
      MPESA_CONSUMER_KEY + ":" + MPESA_CONSUMER_SECRET
    ).toString("base64");

    const tokenData = await requestJson(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        method: "GET",
        headers: {
          Authorization: "Basic " + auth
        }
      }
    );

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0,14);

    const password = Buffer.from(
      MPESA_SHORTCODE + MPESA_PASSKEY + timestamp
    ).toString("base64");

    const payment = await requestJson(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokenData.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({

          BusinessShortCode: MPESA_SHORTCODE,
          Password: password,
          Timestamp: timestamp,

          TransactionType: "CustomerPayBillOnline",

          Amount: amount,
          PartyA: phone,
          PartyB: MPESA_SHORTCODE,
          PhoneNumber: phone,

          CallBackURL: MPESA_CALLBACK_URL,

          AccountReference: "NEWLIFEMAVUENI",
          TransactionDesc: "Living Water " + quantity + "L"

        })
      }
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: payment.CustomerMessage ||
          "M-Pesa Sandbox request accepted.",
        checkoutRequestID: payment.CheckoutRequestID,
        merchantRequestID: payment.MerchantRequestID
      })
    };

  } catch (error) {

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        error: error.message
      })
    };

  }
};
