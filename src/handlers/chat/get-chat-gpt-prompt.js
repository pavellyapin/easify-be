const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
} = require("../utils");

exports.lambdaHandler = async (event) => {
  try {
    const input = JSON.parse(event.body);
    const [chatGPTSecret] = await Promise.all([
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.SECRETS_S3_KEY_NAME,
        "gptSecret",
      ),
    ]);

    const openai = await getOpenAIObject(chatGPTSecret);
    const gptResponse = await getChatGPTPrompt(
      openai,
      input.conversation,
      256,
      "gpt-3.5-turbo",
    );
    console.log(gptResponse);
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      },
      body: JSON.stringify(gptResponse),
    };
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      },
      body: JSON.stringify(error),
    };
  }
};
