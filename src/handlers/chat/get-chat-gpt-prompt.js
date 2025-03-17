const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  verifyAndDecodeToken,
  HEADERS,
} = require("/opt/nodejs/utils");
const admin = require("firebase-admin");

function summarizeConversation(conversation, newMessage, chatPersona) {
  // Limit the conversation length to the last few relevant messages (e.g., last 10).
  const maxMessages = 10;
  const recentMessages = conversation.slice(-maxMessages);

  // Summarize the previous conversation
  const previousSummary = recentMessages
    .map(
      (msg) => `${msg.user === "user" ? "User" : "Assistant"}: ${msg.message}`,
    )
    .join("\n");

  // Return an array with the summarized conversation and the new message
  return [
    {
      role: "system", // GPT understands 'system' for summary or guidance
      content: `Summary of previous conversation:\n${previousSummary}.`,
    },
    {
      role: "developer",
      content: chatPersona,
    },
    {
      role: "user",
      content: newMessage,
    },
  ];
}

exports.lambdaHandler = async (event) => {
  try {
    const input = JSON.parse(event.body);
    const [chatGPTSecret, chatPersona, serviceAccountKey] = await Promise.all([
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.SECRETS_S3_KEY_NAME,
        "gptSecret",
      ),
      getDataFromS3(
        process.env.PROMPTS_S3_BUCKET_NAME,
        process.env.PROMPTS_S3_KEY_NAME,
        "chatPersona",
      ),
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
      ),
    ]);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
      console.log(`[${new Date().toISOString()}] Firebase initialized.`);
    }

    const authResult = await verifyAndDecodeToken(event, admin);
    if (authResult.statusCode !== 200) return authResult;

    // Summarize the conversation with the new message
    const summarizedConversation = summarizeConversation(
      input.conversation,
      input.message,
      chatPersona,
    );

    const openai = await getOpenAIObject(chatGPTSecret);
    const gptResponse = await getChatGPTPrompt(
      openai,
      summarizedConversation,
      1024,
      "gpt-4o-mini",
    );

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify(gptResponse),
    };
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify(error),
    };
  }
};
