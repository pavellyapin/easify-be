exports.lambdaHandler = async (event) => {
  const { connectionId } = event.requestContext;

  try {
    console.log(`Connection closed: ${connectionId}`);
    return {
      statusCode: 200,
      body: "Disconnected.",
    };
  } catch (error) {
    console.error("Error during disconnection:", error);
    return {
      statusCode: 500,
      body: "Failed to disconnect.",
    };
  }
};
