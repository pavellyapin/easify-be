const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
} = require("/opt/nodejs/utils");
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));
    // Parse the SNS message containing an array of financial plan names
    const snsMessage = event.Records[0].Sns.Message;
    const financialPlans = JSON.parse(snsMessage).financialPlans; // Assuming the SNS message is a JSON string array of financial plan names

    // Fetch necessary secrets and service account keys
    const [chatGPTSecret, financialPlanRequest, serviceAccountKey] =
      await Promise.all([
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "financialPlanRequest",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
      ]);

    // Initialize Firebase Admin with the service account key
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
    }

    const firestore = admin.firestore();

    const openai = await getOpenAIObject(chatGPTSecret);

    // Loop through the array of financial plan names
    for (const financialPlanMsg of financialPlans) {
      console.log(`Processing financial plan: ${financialPlanMsg.name}`);

      // Check if the financial plan with the same name already exists in Firestore
      const existingPlan = await checkIfFinancialPlanExists(
        firestore,
        financialPlanMsg.name,
      );
      if (existingPlan) {
        console.log(
          `Financial plan with name "${financialPlanMsg.name}" already exists. Skipping generation.`,
        );
        continue;
      }

      // Get today's date
      const today = new Date().toLocaleDateString("en-US");

      // Create the financial plan request message with today's date
      const financialPlanRequestMessage = {
        role: "user",
        content: `${financialPlanRequest} Financial Plan name: ${financialPlanMsg.name} - Date: ${today}`,
      };

      // Prepare the conversation with the financial plan request
      const conversationWithFinancialPlanRequest = [
        financialPlanRequestMessage,
      ];

      console.log(
        "Prepared conversation:",
        conversationWithFinancialPlanRequest,
      );
      const gptResponse = await getChatGPTPrompt(
        openai,
        conversationWithFinancialPlanRequest,
        8212,
        "gpt-4o-mini",
      );
      console.log("GPT Response:", gptResponse);

      let financialPlan;
      try {
        const sanitizedContent = sanitizeString(gptResponse);
        financialPlan = JSON.parse(sanitizedContent);
        console.log("Parsed financial plan:", financialPlan);

        // Save the financial plan structure to Firestore
        await exports.saveFinancialPlanToFirestore(firestore, financialPlan);
      } catch (error) {
        console.error("Error while saving financial plan:", error);
        continue; // Skip to the next financial plan in case of error
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Financial plans processed successfully.",
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.saveFinancialPlanToFirestore = async (firestore, financialPlan) => {
  console.log("Saving financial plan to Firestore");
  const financialPlansCollection = firestore.collection("financialPlans");

  // Check if tags is a string and convert it to an array if necessary
  if (typeof financialPlan.tags === "string") {
    financialPlan.tags = financialPlan.tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase());
  } else if (Array.isArray(financialPlan.tags)) {
    // Normalize the tags array to lowercase
    financialPlan.tags = financialPlan.tags.map((tag) =>
      tag.toLowerCase().trim(),
    );
  }

  // Add the createdDate field with the current date
  financialPlan.createdDate = new Date().toISOString();

  // Save the financial plan to Firestore
  const document = await financialPlansCollection.add(financialPlan);
  console.log(
    "Financial plan successfully saved to Firestore with ID:",
    document.id,
  );
};

// Function to check if a financial plan with the same name already exists
const checkIfFinancialPlanExists = async (firestore, financialPlanName) => {
  const financialPlansCollection = firestore.collection("financialPlans");
  const querySnapshot = await financialPlansCollection
    .where("name", "==", financialPlanName)
    .get();

  if (!querySnapshot.empty) {
    // Financial plan with the same name already exists
    return true;
  }

  // No financial plan with the same name found
  return false;
};
