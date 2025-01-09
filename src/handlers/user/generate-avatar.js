const {
  getDataFromS3,
  getOpenAIObject,
  generateImageAndSavetoStorage,
  verifyAndDecodeToken,
  HEADERS
} = require('/opt/nodejs/utils');
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  console.log("Event received:", JSON.stringify(event, null, 2));

  try {
    // Initialize and fetch necessary configurations
    const [chatGPTSecret, serviceAccountKey, avatarPrompt] = await Promise.all([
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.SECRETS_S3_KEY_NAME,
        "gptSecret",
      ),
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
      ),
      getDataFromS3(
        process.env.PROMPTS_S3_BUCKET_NAME,
        process.env.PROMPTS_S3_KEY_NAME,
        "avatarPrompt",
      ),
    ]);

    console.log("Service Account Key and GPT Secret retrieved.");

    // Initialize Firebase Admin SDK if not already initialized
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // Ensure correct storage bucket
      });
    }

    // Verify and decode the token
    const authResult = await verifyAndDecodeToken(event, admin);
    if (authResult.statusCode !== 200) return authResult;

    const userId = authResult.decodedToken.uid;
    // Extract user data from event
    if (!userId) {
      throw new Error("User ID not provided in the event");
    }

    const firestore = admin.firestore();
    const bucket = admin.storage().bucket();
    const openai = await getOpenAIObject(chatGPTSecret);

    // Fetch user data from Firestore
    const userDoc = await firestore.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      throw new Error("User not found");
    }
    const userData = userDoc.data();

    // Generate avatar prompt based on user data
    const prompt = generateAvatarPrompt(userData, avatarPrompt);

    // Generate and save avatar
    const avatarUrl = await generateAvatarAndSave(
      openai,
      bucket,
      userId,
      prompt,
    );

    // Update user's profile with the new avatar URL
    await firestore.collection("users").doc(userId).update({ avatarUrl });

    // Return the URL as response
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ avatarUrl }),
    };
  } catch (error) {
    console.error("Error generating avatar:", error);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// Function to generate a prompt for the avatar based on user data
const generateAvatarPrompt = (userData) => {
  const avatarData = userData.avatar || {};

  // Initialize the prompt string
  let prompt =
    "Generate an avatar for a person. Shoulders and up with background color #eefaf6 and nothing in the background.";

  // Append data to the prompt only if it exists
  if (avatarData.name) {
    prompt += ` The person's name is ${avatarData.name}.`;
  }

  if (avatarData.gender) {
    prompt += ` The person is ${avatarData.gender}.`;
  }

  if (avatarData.ageRange) {
    prompt += ` They belong to the ${avatarData.ageRange} age group.`;
  }

  if (avatarData.ethnicity) {
    prompt += ` Ethnicity is ${avatarData.ethnicity}.`;
  }

  if (avatarData.hairColor) {
    prompt += ` They have ${avatarData.hairColor} hair.`;
  }

  if (avatarData.eyeColor) {
    prompt += ` Their eye color is ${avatarData.eyeColor}.`;
  }

  if (avatarData.clothingStyle) {
    prompt += ` Their clothing style is described as ${avatarData.clothingStyle}.`;
  }

  if (avatarData.accessories) {
    prompt += ` They are wearing ${avatarData.accessories}.`;
  }

  if (avatarData.otherInfo) {
    prompt += ` Additional features: ${avatarData.otherInfo}.`;
  }

  // Trim the resulting prompt and return
  return prompt.trim();
};

// Function to generate avatar using DALL-E and save it to Firebase Storage
const generateAvatarAndSave = async (openai, bucket, userId, prompt) => {
  try {
    console.log(`Generating avatar for user: ${userId} with prompt: ${prompt}`);

    // Generate the image
    const avatarUrl = await generateImageAndSavetoStorage(
      openai,
      bucket,
      prompt,
      { name: `avatar` }, // Metadata for the file
      "dall-e-3",
      userId,
    );

    console.log(`Avatar generated and saved to: ${avatarUrl}`);
    return avatarUrl;
  } catch (error) {
    console.error("Error generating avatar:", error);
    throw new Error("Failed to generate avatar.");
  }
};
