const AWS = require("aws-sdk");
const { PDFDocument } = require("pdf-lib");
const {
  getDataFromS3,
  verifyAndDecodeSocketToken,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  sendMessage
} = require('/opt/nodejs/utils');
const admin = require("firebase-admin");
const textract = new AWS.Textract();

// Function to split a PDF into pages
const splitPDFIntoPages = async (pdfBuffer) => {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = [];
  for (let i = 0; i < pdfDoc.getPageCount(); i++) {
    const newPdf = await PDFDocument.create();
    const [page] = await newPdf.copyPages(pdfDoc, [i]);
    newPdf.addPage(page);
    const pdfBytes = await newPdf.save();
    pages.push(pdfBytes);
  }
  return pages;
};

// Function to extract text from a single PDF page
const extractTextFromSinglePageWithTextract = async (pdfPageBuffer) => {
  const params = {
    Document: { Bytes: pdfPageBuffer },
  };
  try {
    const data = await textract.detectDocumentText(params).promise();
    let extractedText = "";
    data.Blocks.forEach((block) => {
      if (block.BlockType === "LINE") {
        extractedText += block.Text + "\n";
      }
    });
    return extractedText.trim();
  } catch (error) {
    console.error("Error calling Textract:", error);
    throw new Error(
      `Failed to analyze document using Textract: ${error.message}`,
    );
  }
};

exports.lambdaHandler = async (event) => {
  const { requestContext, body } = event;
  const { connectionId, domainName, stage } = requestContext;
  const endpoint = `${domainName}/${stage}`;

  try {
    const { token, fileName } = JSON.parse(body);

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
          "miniResumePrompt",
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

    // Verify and decode the token
    const authResult = await verifyAndDecodeSocketToken(token, admin);
    if (authResult.statusCode !== 200) {
      console.error("Token verification failed.");
      await sendMessage(connectionId, endpoint, {
        status: "error",
        message: "Unauthorized",
      });
      return { statusCode: 401, body: "Unauthorized" };
    }

    const userId = authResult.decodedToken.uid;

    const bucket = admin.storage().bucket();
    const fileRef = bucket.file(`${userId}/${fileName}`);
    const [fileData] = await fileRef.download();
    if (!fileData)
      throw new Error("Could not download file from Firebase Storage.");

    const pdfPages = await splitPDFIntoPages(fileData);
    const pageTextPromises = pdfPages.map((pdfPageBuffer) =>
      extractTextFromSinglePageWithTextract(pdfPageBuffer),
    );
    const extractedPageTexts = await Promise.all(pageTextPromises);
    const completeExtractedText = extractedPageTexts.join("\n");

    const firestore = admin.firestore();
    const resumeRef = firestore
      .collection(`users/${userId}/resumes`)
      .doc(fileName)
      .collection("extracts")
      .doc();
    await resumeRef.set({
      extractedText: completeExtractedText,
      extractionDate: new Date().toISOString(),
    });

    const openai = await getOpenAIObject(chatGPTSecret);
    const resumeAnalysisMessage = {
      role: "user",
      content: `${completeExtractedText}\n\n${resumeAnalysisPrompt}`,
    };
    const conversation = [resumeAnalysisMessage];

    const gptResponse = await getChatGPTPrompt(
      openai,
      conversation,
      2048,
      "gpt-4o-mini",
    );

    let analysisResult;
    try {
      const sanitizedContent = sanitizeString(gptResponse);
      analysisResult = JSON.parse(sanitizedContent);
    } catch (parseError) {
      console.error("Error parsing GPT response:", parseError);
      throw new Error("Invalid resume analysis format from GPT");
    }

    const analysisResultObj = {
      analysis: analysisResult,
      scanDate: new Date().toISOString(),
    };

    const resumeReportsRef = firestore
      .collection(`users/${userId}/resumes`)
      .doc(fileName)
      .collection("reports")
      .doc("miniScan");
    await resumeReportsRef.set(analysisResultObj);

    await sendMessage(connectionId, endpoint, {
      status: "success",
      analysisResultObj,
    });
    return { statusCode: 200 };
  } catch (error) {
    console.error("Error:", error);
    await sendMessage(connectionId, endpoint, {
      status: "error",
      message: error.message,
    });
    return { statusCode: 500 };
  }
};
