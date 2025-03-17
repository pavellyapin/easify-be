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

    // Parse the SNS message containing an array of industry names
    const snsMessage = event.Records[0].Sns.Message;
    const industries = JSON.parse(snsMessage).industries;

    // Fetch necessary secrets and service account keys
    const [chatGPTSecret, industryRequest, serviceAccountKey] =
      await Promise.all([
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "careersRequest",
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

    // Loop through the array of industry names
    for (const industryMsg of industries) {
      console.log(`Processing industry: ${industryMsg}`);

      // Check if the industry with the same name already exists in Firestore
      const existingIndustry = await checkIfIndustryExists(
        firestore,
        industryMsg,
      );
      if (existingIndustry) {
        console.log(
          `Industry with name "${industryMsg}" already exists. Skipping generation.`,
        );
        continue;
      }

      const industryRequestMessage = {
        role: "user",
        content: `Industry name: ${industryMsg} ${industryRequest}`,
      };
      const conversationWithIndustryRequest = [industryRequestMessage];

      console.log("Prepared conversation:", conversationWithIndustryRequest);
      const gptResponse = await getChatGPTPrompt(
        openai,
        conversationWithIndustryRequest,
        4096,
        "gpt-4o-mini",
      );
      console.log("GPT Response:", gptResponse);

      let industry;
      try {
        const sanitizedContent = sanitizeString(gptResponse);
        industry = JSON.parse(sanitizedContent);
        console.log("Parsed industry:", industry);

        // Save the industry structure with jobs to Firestore
        await exports.saveIndustryToFirestore(firestore, industry);
      } catch (error) {
        console.error("Error while saving industry:", error);
        continue; // Skip to the next industry in case of error
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Industries processed successfully." }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.saveIndustryToFirestore = async (firestore, industry) => {
  console.log("Saving industry to Firestore");
  const industriesCollection = firestore.collection("industries");
  // Normalize the tags to lowercase before saving
  if (industry.tags && Array.isArray(industry.tags)) {
    industry.tags = industry.tags.map((tag) => tag.toLowerCase());
  }
  // Add the createdDate field with the current date
  industry.createdDate = new Date().toISOString();
  const document = await industriesCollection.add(industry);
  console.log("Industry successfully saved to Firestore with ID:", document.id);
};

// Function to check if an industry with the same name already exists
const checkIfIndustryExists = async (firestore, industryName) => {
  const industriesCollection = firestore.collection("industries");
  const querySnapshot = await industriesCollection
    .where("name", "==", industryName)
    .get();

  if (!querySnapshot.empty) {
    // Industry with the same name already exists
    return true;
  }

  // No industry with the same name found
  return false;
};
