const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
} = require("/opt/nodejs/utils");
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  console.log("Event received:", JSON.stringify(event, null, 2));

  try {
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
          "populateIndustryPrompt",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
      ]);

    // Initialize Firebase Admin
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
    }

    const firestore = admin.firestore();
    const openai = await getOpenAIObject(chatGPTSecret);

    // Fetch all industries from Firestore
    const industriesCollection = firestore.collection("industries");
    const snapshot = await industriesCollection.get();

    if (snapshot.empty) {
      console.log("No industries found in Firestore.");
      return;
    }

    console.log(`Found ${snapshot.size} industries in Firestore.`);

    // Filter documents where updatedDate is null or does not exist
    const industriesToProcess = snapshot.docs.filter((doc) => {
      const data = doc.data();
      return !data.updatedDate || data.updatedDate === null;
    });

    if (industriesToProcess.length === 0) {
      console.log("No industries to process.");
      return;
    }

    console.log(`Found ${industriesToProcess.length} industries to process.`);

    // Loop through each industry to process
    for (const doc of industriesToProcess) {
      const industryData = doc.data();
      const industryName = industryData.name;

      console.log(`Processing industry: ${industryName}`);

      const industryRequestMessage = {
        role: "user",
        content: `Industry name: ${industryName}. ${industryRequest}`,
      };
      const conversation = [industryRequestMessage];

      // Send prompt to GPT
      console.log("Sending prompt to GPT:", conversation);
      const gptResponse = await getChatGPTPrompt(
        openai,
        conversation,
        4096,
        "gpt-4o-mini",
      );
      console.log("GPT Response:", gptResponse);

      let detailedIndustry;
      try {
        const sanitizedContent = sanitizeString(gptResponse);
        detailedIndustry = JSON.parse(sanitizedContent);
        console.log("Parsed detailed industry:", detailedIndustry);

        // Save detailed industry info back to Firestore
        await exports.saveDetailedIndustryToFirestore(
          firestore,
          doc.id,
          detailedIndustry,
        );
      } catch (error) {
        console.error(`Error processing industry ${industryName}:`, error);
        continue; // Skip to the next industry in case of error
      }
    }

    console.log("Industries processed successfully.");
  } catch (error) {
    console.error("Error processing industries:", error);
  }
};

// Save the detailed industry information back to Firestore
exports.saveDetailedIndustryToFirestore = async (
  firestore,
  docId,
  detailedIndustry,
) => {
  console.log(`Saving detailed information for industry ID: ${docId}`);
  const industryDocRef = firestore.collection("industries").doc(docId);

  if (detailedIndustry.category) {
    detailedIndustry.category = detailedIndustry.category.trim().toLowerCase();
  }

  // Add or merge the detailed information into the existing document
  await industryDocRef.set(
    {
      detailedInfo: detailedIndustry,
      updatedDate: new Date().toISOString(),
    },
    { merge: true },
  );
  console.log(`Detailed information for industry ID ${docId} saved.`);
};
