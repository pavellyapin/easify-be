/* eslint-disable no-case-declarations */
// Import necessary modules and functions
const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  verifyAndDecodeToken,
} = require("../utils");
const admin = require("firebase-admin");
const { HEADERS } = require("../const");

exports.lambdaHandler = async (event) => {
  try {
    const startTime = new Date();
    console.log(`[${startTime.toISOString()}] Start: Received event.`);

    const [chatGPTSecret, easifyRequest, serviceAccountKey] = await Promise.all(
      [
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "easifyRequest",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
      ],
    );

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
      console.log(`[${new Date().toISOString()}] Firebase initialized.`);
    }

    const authResult = await verifyAndDecodeToken(event, admin);
    if (authResult.statusCode !== 200) return authResult;

    const userId = authResult.decodedToken.uid;
    console.log(
      `[${new Date().toISOString()}] Token verified for userId: ${userId}.`,
    );

    const body = JSON.parse(event.body);
    const { type, item } = body.easifyRequest;
    if (!type || !item || !item.id) {
      throw new Error("Missing required parameters: type or item.");
    }

    // Firestore collection lookup
    const collection = {
      course: "courses",
      workout: "workouts",
      recipe: "recipes",
    }[type];

    if (!collection) {
      throw new Error(
        "Invalid type. Must be 'course', 'workout', or 'recipe'.",
      );
    }

    const docRef = admin.firestore().collection(collection).doc(item.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new Error(`No document found for ID: ${item.id}`);
    }

    const data = doc.data();
    let description, promptContext;

    // Max tokens and model variables
    const maxTokens = 1500;
    const model = "gpt-3.5-turbo";

    // Prompt construction based on type
    switch (type) {
      case "course":
        const chapter = data.chapters?.[item.chapterNumber];
        const topic = chapter?.topics?.[item.topicNumber];
        const point = topic?.points?.[item.pointIndex];
        description = `${point?.title} - ${point?.desc} - ${point?.content}`;

        promptContext = `I am reading the course "${data.name}". In chapter "${chapter?.name}", topic "${topic?.name}", and point "${point?.title}", it says: "${description}". ${easifyRequest}`;
        break;

      case "workout":
        const exercises =
          item.stage === 1 ? data.warmUp.exercises : data.routine.exercises;
        const exercise = exercises?.[item.exerciseIndex];
        description = exercise?.name + " " + exercise?.description;

        promptContext = `I am doing the workout "${data.name}". The exercise "${exercise?.name}" is described as: "${description}". ${easifyRequest}`;
        break;

      case "recipe":
        const instructions =
          item.stage === 1 ? data.prepare : data.instructions;
        const instruction = instructions?.[item.instructionIndex];
        description = instruction?.name + " " + instruction?.description;

        promptContext = `I am following the recipe "${data.name}". In the step "${instruction?.name}", it says: "${description}". ${easifyRequest}`;
        break;

      default:
        throw new Error("Unhandled type in switch case.");
    }

    if (!description) {
      throw new Error("Description not found for the specified part.");
    }

    const contextMessage = {
      role: "user",
      content: promptContext,
    };

    console.log(
      `[${new Date().toISOString()}] Prepared context message for GPT request.`,
    );

    const openai = await getOpenAIObject(chatGPTSecret);
    console.log(
      `[${new Date().toISOString()}] Initialized OpenAI object with provided secret.`,
    );

    // GPT response
    const gptResponse = await getChatGPTPrompt(
      openai,
      [contextMessage],
      maxTokens,
      model,
    );

    console.log(
      `[${new Date().toISOString()}] Received response from GPT model.`,
    );

    let easifyResponse;
    try {
      // Sanitize and parse the GPT response
      const sanitizedContent = sanitizeString(gptResponse);
      easifyResponse = JSON.parse(sanitizedContent);
      console.log(
        `[${new Date().toISOString()}] Parsed GPT response and converted to JSON format.`,
      );
    } catch (parseError) {
      console.error(
        `[${new Date().toISOString()}] Error parsing GPT response to JSON:`,
        parseError,
      );
      throw new Error("Invalid format from ChatGPT");
    }
    // Save request and response to Firebase with a unique document ID
    const userDocRef = admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("easifyResponses");

    const responseDoc = {
      type,
      itemId: item.id,
      request: body.easifyRequest,
      response: easifyResponse,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userDocRef.add(responseDoc);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify(responseDoc),
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error encountered:`, error);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
