const AWS = require('aws-sdk');
const { PDFDocument } = require('pdf-lib');
const { getDataFromS3, verifyAndDecodeToken } = require('../utils');
const { HEADERS } = require('../const');
const admin = require('firebase-admin');
const textract = new AWS.Textract();

// Split a PDF into individual pages
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

// Extract text from a single page using Textract
const extractTextFromSinglePageWithTextract = async (pdfPageBuffer) => {
    const params = {
        Document: { Bytes: pdfPageBuffer }
    };
    try {
        const data = await textract.detectDocumentText(params).promise();
        let extractedText = '';
        data.Blocks.forEach((block) => {
            if (block.BlockType === 'LINE') {
                extractedText += block.Text + '\n';
            }
        });
        return extractedText.trim();
    } catch (error) {
        console.error('Error calling Textract:', error);
        throw new Error(`Failed to analyze document using Textract: ${error.message}`);
    }
};

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));
        const { fileName } = JSON.parse(event.body);

        const [serviceAccountKey] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.FIREBASE_ACCOUNT_S3_KEY_NAME)
        ]);

        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccountKey),
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET
            });
        }

        const authResult = await verifyAndDecodeToken(event, admin);
        if (authResult.statusCode !== 200) return authResult;

        const userId = authResult.decodedToken.uid;
        const bucket = admin.storage().bucket();
        const fileRef = bucket.file(`${userId}/${fileName}`);

        const [fileData] = await fileRef.download();
        if (!fileData) throw new Error('Could not download file from Firebase Storage.');

        const pdfPages = await splitPDFIntoPages(fileData);
        const pageTextPromises = pdfPages.map(pdfPageBuffer => extractTextFromSinglePageWithTextract(pdfPageBuffer));
        const extractedPageTexts = await Promise.all(pageTextPromises);

        const completeExtractedText = extractedPageTexts.join('\n');
        console.log('Complete extracted text from PDF:', completeExtractedText);

        const firestore = admin.firestore();
        const resumeRef = firestore
        .collection(`users/${userId}/resumes`)
        .doc(fileName)
        .collection('extracts')
        .doc();
  
        await resumeRef.set({
            extractedText: completeExtractedText,
            extractionDate: new Date().toISOString(),
        });

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ message: 'Text extraction complete', documentId: resumeRef.id })
        };
    } catch (error) {
        console.error('Error during text extraction:', error);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: error.message })
        };
    }
};