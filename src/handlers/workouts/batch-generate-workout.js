const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  generateImageAndSavetoStorage,
} = require('/opt/nodejs/utils');
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));

    // Parse the SNS message containing an array of workout names
    const snsMessage = event.Records[0].Sns.Message;
    const workouts = JSON.parse(snsMessage).workouts; // Assuming the SNS message is a JSON string array of workout names

    // Fetch necessary secrets and service account keys
    const [
      chatGPTSecret,
      workoutRequest,
      serviceAccountKey,
      workoutImagePrompt,
    ] = await Promise.all([
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.SECRETS_S3_KEY_NAME,
        "gptSecret",
      ),
      getDataFromS3(
        process.env.PROMPTS_S3_BUCKET_NAME,
        process.env.PROMPTS_S3_KEY_NAME,
        "workoutRequest",
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
    // Initialize Firebase Admin with the service account key
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // Use the Firebase Storage bucket name
      });
    }
    const firestore = admin.firestore();
    const bucket = admin.storage().bucket();

    const openai = await getOpenAIObject(chatGPTSecret);

    // Loop through the array of workout names
    for (const workoutObj of workouts) {
      const workoutName = workoutObj.name ? workoutObj.name : workoutObj;
      console.log(`Processing workout: ${workoutName}`);

      // Check if the workout with the same name already exists in Firestore
      const existingWorkout = await checkIfWorkoutExists(
        firestore,
        workoutName,
      );
      if (existingWorkout) {
        console.log(
          `Workout with name "${workoutName}" already exists. Skipping generation.`,
        );
        continue;
      }

      const workoutRequestMessage = {
        role: "user",
        content: `Workout name: ${workoutName}. ${workoutRequest}`,
      };
      const conversationWithWorkoutRequest = [workoutRequestMessage];

      console.log("Prepared conversation:", conversationWithWorkoutRequest);
      const gptResponse = await getChatGPTPrompt(
        openai,
        conversationWithWorkoutRequest,
        2048,
        "gpt-4o-mini",
      );
      console.log("GPT Response:", gptResponse);

      let workout;
      try {
        const sanitizedContent = sanitizeString(gptResponse);
        workout = JSON.parse(sanitizedContent);
        console.log("Parsed workout:", workout);

        // Check if image generation is enabled
        const enableImageGen = process.env.ENABLE_IMAGE_GEN === "true";
        let imageUrl = "";

        if (enableImageGen) {
          try {
            const workoutPrompt = workoutImagePrompt.replace(
              "{name}",
              workoutName,
            );

            // Try generating the image
            imageUrl = await generateImageAndSavetoStorage(
              openai,
              bucket,
              workoutPrompt,
              { name: workoutName },
              "dall-e-3",
            );
            console.log(
              "Image generated successfully for the workout:",
              workoutName,
            );
          } catch (imageError) {
            console.error(
              "Image generation failed for the workout:",
              workoutName,
              imageError,
            );
            // Optionally, you can set a default placeholder image URL
            imageUrl = "";
            console.log(
              "Using placeholder image for the workout:",
              workoutName,
            );
          }
        }
        workout.image = imageUrl;

        // Save the workout structure to Firestore
        await exports.saveWorkoutToFirestore(firestore, workout);
      } catch (error) {
        console.error("Error while saving workout:", error);
        continue; // Skip to the next workout in case of error
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Workouts processed successfully." }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.saveWorkoutToFirestore = async (firestore, workout) => {
  console.log("Saving workout to Firestore");
  const workoutsCollection = firestore.collection("workouts");

  // Check if tags is a string and convert it to an array if necessary
  if (typeof workout.tags === "string") {
    workout.tags = workout.tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase());
  } else if (Array.isArray(workout.tags)) {
    // Normalize the tags array to lowercase
    workout.tags = workout.tags.map((tag) => tag.toLowerCase().trim());
  }

  if (workout.category) {
    workout.category = workout.category.trim().toLowerCase();
  }

  if (workout.level) {
    // Possible valid values for level field
    const validLevels = ["beginner", "intermediate", "advanced"];
    let level = workout.level.toLowerCase(); // Normalize level to lowercase
    // If the level is not one of the valid values, set to "intermediate"
    if (!validLevels.includes(level)) {
      level = "intermediate";
    } else {
      workout.level = level;
    }
  }

  // Add the createdDate field with the current date
  workout.createdDate = new Date().toISOString();

  // Save the workout to Firestore
  const document = await workoutsCollection.add(workout);
  console.log("Workout successfully saved to Firestore with ID:", document.id);
};

// Function to check if a workout with the same name already exists
const checkIfWorkoutExists = async (firestore, workoutName) => {
  const workoutsCollection = firestore.collection("workouts");
  const querySnapshot = await workoutsCollection
    .where("name", "==", workoutName)
    .get();

  if (!querySnapshot.empty) {
    // Workout with the same name already exists
    return true;
  }

  // No workout with the same name found
  return false;
};
