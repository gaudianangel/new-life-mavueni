
exports.handler = async (event) => {

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({
        error: "Method not allowed"
      })
    };
  }

  try {

    const callback = JSON.parse(event.body || "{}");

    console.log(
      "NEW LIFE MAVUENI MPESA CALLBACK:",
      JSON.stringify(callback)
    );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ResultCode: 0,
        ResultDesc: "Accepted"
      })
    };

  } catch (error) {

    console.error("Callback error:", error);

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "Invalid callback"
      })
    };

  }

};
