const {
  getDataFromS3,
  getOpenAIObject,
  generateImageAndSavetoStorage,
} = require('/opt/nodejs/utils');
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  console.log("Event received:", JSON.stringify(event, null, 2));
  try {
    const snsMessage = event.Records[0].Sns.Message;
    console.log("SNS Message:", snsMessage);
    const input = JSON.parse(snsMessage);

    const [chatGPTSecret, serviceAccountKey, imagePrompt] = await Promise.all([
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
        "workoutImageRequest",
      ),
    ]);

    console.log("Firestore Service Account Key:", serviceAccountKey);
    console.log("ChatGPT Secret:", chatGPTSecret);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });
    }

    const firestore = admin.firestore();
    const bucket = admin.storage().bucket();
    const openai = await getOpenAIObject(chatGPTSecret);

    console.log("OpenAI Object initialized.");

    const numberOfImagesToGenerate = input.count || 5;

    await findAndGenerateMissingImages(
      firestore,
      openai,
      bucket,
      numberOfImagesToGenerate,
      imagePrompt,
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Images generated and updated successfully",
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

const findAndGenerateMissingImages = async (
  firestore,
  openai,
  bucket,
  count,
  imagePrompt,
) => {
  console.log(`Searching for up to ${count} objects with missing images.`);
  try {
    const collection = firestore.collection("workouts");
    const querySnapshot = await collection.limit(100).get(); // Fetch a larger batch for filtering

    const objectsToProcess = [];
    for (const doc of querySnapshot.docs) {
      const object = doc.data();
      const imagePath = object.image;

      if (!imagePath) {
        console.log(
          `Object ${object.name} has no image. Adding to process queue.`,
        );
        objectsToProcess.push({ id: doc.id, name: object.name, image: "" });
      } else {
        try {
          // Extract file name from the image URL
          const fileName = imagePath.split("/").pop();
          if (!fileName) {
            console.warn(`Unable to extract file name from URL: ${imagePath}`);
            continue;
          }
          const [exists] = await bucket.file(fileName).exists();
          if (!exists) {
            console.log(
              `Image ${fileName} for object ${object.name} does not exist in bucket. Adding to process queue.`,
            );
            objectsToProcess.push({
              id: doc.id,
              name: object.name,
              image: imagePath,
            });
          }
        } catch (error) {
          console.error(
            `Error checking image for object ${object.name}:`,
            error,
          );
        }
      }

      if (objectsToProcess.length >= count) {
        break;
      }
    }

    console.log(`Found ${objectsToProcess.length} objects to process.`);

    for (const obj of objectsToProcess) {
      const prompt = imagePrompt.replace("{name}", obj.name);
      let imageUrl = obj.image;

      try {
        imageUrl = await generateImageAndSavetoStorage(
          openai,
          bucket,
          prompt,
          { name: obj.name },
          "dall-e-3",
        );
        console.log(`Image generated for ${obj.name}`);
      } catch (error) {
        console.error(`Failed to generate image for ${obj.name}:`, error);
      }

      try {
        await collection.doc(obj.id).update({ image: imageUrl });
        console.log(`Updated Firestore with new image URL for ${obj.name}`);
      } catch (error) {
        console.error(`Failed to update Firestore for ${obj.name}:`, error);
      }
    }
  } catch (error) {
    console.error("Error while processing objects:", error);
    throw new Error("Failed to process objects with missing images.");
  }
};
