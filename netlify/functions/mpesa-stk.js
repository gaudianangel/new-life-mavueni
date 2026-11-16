
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
      body: JSON.stringify({ error: "Method not allowed" })
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

    if (
      !MPESA_CONSUMER_KEY ||
      !MPESA_CONSUMER_SECRET ||
      !MPESA_SHORTCODE ||
      !MPESA_PASSKEY ||
      !MPESA_CALLBACK_URL
    ) {
      throw new Error("M-PESA environment variables are missing.");
    }

    const data = JSON.parse(event.body || "{}");

    let phone = String(data.phone || "").replace(/\s+/g, "");

    if (/^0[17]\d{8}$/.test(phone)) {
      phone = "254" + phone.substring(1);
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
      (data.product !== "water_500ml" &&
       data.product !== "water_1l" &&
       quantity !== 1)
    ) {
      throw new Error("Invalid quantity.");
    }

    const amount = item.price * quantity;

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
      .slice(0, 14);

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
          AccountReference: "NEWLIFE",
          TransactionDesc: item.name.substring(0, 13)
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
          "Payment request accepted for processing.",
        checkoutRequestID: payment.CheckoutRequestID,
        merchantRequestID: payment.MerchantRequestID,
        amount: amount,
        item: item.name
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
