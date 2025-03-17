const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  verifyAndDecodeToken,
  HEADERS,
} = require("/opt/nodejs/utils");
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));
    const { fileName } = JSON.parse(event.body);

    const [chatGPTSecret, resumeAnalysisPrompt, serviceAccountKey] =
      await Promise.all([
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "resumeAnalysisPrompt",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
      ]);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });
    }

    const authResult = await verifyAndDecodeToken(event, admin);
    if (authResult.statusCode !== 200) return authResult;

    const userId = authResult.decodedToken.uid;
    const firestore = admin.firestore();
    const extractsCollectionRef = firestore
      .collection(`users/${userId}/resumes`)
      .doc(fileName)
      .collection("extracts");

    // Query for the latest extract sorted by extractionDate
    const querySnapshot = await extractsCollectionRef
      .orderBy("extractionDate", "desc")
      .limit(1)
      .get();

    if (querySnapshot.empty) throw new Error("Extracted text not found.");
    const latestExtractDoc = querySnapshot.docs[0];
    const extractedText = latestExtractDoc.data();

    console.log("Latest extract fetched:", extractedText["extractedText"]);

    const openai = await getOpenAIObject(chatGPTSecret);
    const resumeAnalysisMessage = {
      role: "user",
      content: `${resumeAnalysisPrompt}\n\n${extractedText["extractedText"]}`,
    };
    const conversation = [resumeAnalysisMessage];

    console.log("Sending conversation to GPT-4:", conversation);
    const gptResponse = await getChatGPTPrompt(
      openai,
      conversation,
      4096,
      "gpt-4o-mini",
    );

    console.log("Received GPT-4 response:", gptResponse);

    let analysisResult;
    try {
      const sanitizedContent = sanitizeString(gptResponse);
      analysisResult = JSON.parse(sanitizedContent);
      console.log("Parsed analysis result:", analysisResult);
    } catch (parseError) {
      console.error("Error parsing GPT response:", parseError);
      throw new Error("Invalid resume analysis format from GPT");
    }

    const scanDate = new Date().toISOString();
    const resumeRef = firestore
      .collection(`users/${userId}/resumes`)
      .doc(fileName)
      .collection("reports")
      .doc("scan");
    await resumeRef.set({
      analysis: analysisResult,
      scanDate: scanDate,
    });

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ analysis: resumeRef.id }),
    };
  } catch (error) {
    console.error("Error during resume analysis:", error);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
