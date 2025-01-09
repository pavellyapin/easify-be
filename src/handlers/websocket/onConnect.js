exports.lambdaHandler = async (event) => {
  const { connectionId } = event.requestContext;

  try {
    console.log(`Connection established: ${connectionId}`);
    return {
      statusCode: 200,
      body: "Connected.",
    };
  } catch (error) {
    console.error("Error during connection:", error);
    return {
      statusCode: 500,
      body: "Failed to connect.",
    };
  }
};
