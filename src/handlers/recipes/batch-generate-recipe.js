const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  generateImageAndSavetoStorage,
  sanitizeString,
} = require('/opt/nodejs/utils');
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));

    // Parse the SNS message containing an array of recipe names
    const snsMessage = event.Records[0].Sns.Message;
    const recipes = JSON.parse(snsMessage).recipes; // Assuming the SNS message is a JSON string array of recipe names

    // Fetch necessary secrets and service account keys
    const [chatGPTSecret, recipeRequest, serviceAccountKey] = await Promise.all(
      [
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "recipeRequest",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
      ],
    );

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

    // Loop through the array of recipe names
    for (const recipeObj of recipes) {
      const recipeName = recipeObj.name ? recipeObj.name : recipeObj;
      console.log(`Processing recipe: ${recipeName}`);

      // Check if the recipe with the same name already exists in Firestore
      const existingRecipe = await checkIfRecipeExists(firestore, recipeName);
      if (existingRecipe) {
        console.log(
          `Recipe with name "${recipeName}" already exists. Skipping generation.`,
        );
        continue;
      }

      const recipeRequestMessage = {
        role: "user",
        content: `Recipe name: ${recipeName} ${recipeRequest} `,
      };
      const conversationWithRecipeRequest = [recipeRequestMessage];

      console.log("Prepared conversation:", conversationWithRecipeRequest);
      const gptResponse = await getChatGPTPrompt(
        openai,
        conversationWithRecipeRequest,
        2048,
        "gpt-4o-mini",
      );
      console.log("GPT Response:", gptResponse);

      let recipe;
      try {
        const sanitizedContent = sanitizeString(gptResponse);
        recipe = JSON.parse(sanitizedContent);
        console.log("Parsed recipe:", recipe);

        // Check if image generation is enabled
        const enableImageGen = true;
        let imageUrl = "";

        if (enableImageGen) {
          try {
            // Generate an image based on the recipe description
            const imagePrompt = recipe.description + ". Photograph style"; // Use the description for image generation
            imageUrl = await generateImageAndSavetoStorage(
              openai,
              bucket,
              imagePrompt,
              { name: recipeName },
              "dall-e-3",
            );
            console.log(
              "Image generated successfully for the recipe:",
              recipeName,
            );
          } catch (imageError) {
            console.error(
              "Image generation failed for the recipe:",
              recipeName,
              imageError,
            );
            // Optionally, you can set a default placeholder image URL
            imageUrl = "";
            console.log("Using placeholder image for the recipe:", recipeName);
          }
        }
        // Attach the Firebase Storage URL to the recipe object
        recipe.image = imageUrl;

        // Save the recipe structure to Firestore
        await exports.saveRecipeToFirestore(firestore, recipe);
      } catch (error) {
        console.error("Error while saving recipe:", error);
        continue; // Skip to the next recipe in case of error
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Recipes processed successfully." }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.saveRecipeToFirestore = async (firestore, recipe) => {
  console.log("Saving recipe to Firestore");
  const recipesCollection = firestore.collection("recipes");
  // Normalize the tags to lowercase before saving
  if (recipe.tags && Array.isArray(recipe.tags)) {
    recipe.tags = recipe.tags.map((tag) => tag.toLowerCase());
  }
  // Normalize the ingredient names to lowercase before saving
  if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
    recipe.ingredients = recipe.ingredients.map((ingredient) => {
      return {
        ...ingredient,
        name: ingredient.name.trim().toLowerCase(), // Normalize ingredient name
      };
    });
  }

  // Normalize the category, level, and cuisine to lowercase
  if (recipe.category) {
    recipe.category = recipe.category.trim().toLowerCase();
  }

  if (recipe.level) {
    const validLevels = ["beginner", "intermediate", "advanced"];
    let level = recipe.level.toLowerCase(); // Normalize level to lowercase
    // If the level is not one of the valid values, set to "intermediate"
    if (!validLevels.includes(level)) {
      level = "intermediate";
    } else {
      recipe.level = level;
    }
  }

  if (recipe.cuisine) {
    recipe.cuisine = recipe.cuisine.trim().toLowerCase();
  }
  // Add the createdDate field with the current date
  recipe.createdDate = new Date().toISOString();
  const document = await recipesCollection.add(recipe);
  console.log("Recipe successfully saved to Firestore with ID:", document.id);
};

// Function to check if a recipe with the same name already exists
const checkIfRecipeExists = async (firestore, recipeName) => {
  const recipesCollection = firestore.collection("recipes");
  const querySnapshot = await recipesCollection
    .where("name", "==", recipeName)
    .get();

  if (!querySnapshot.empty) {
    // Recipe with the same name already exists
    return true;
  }

  // No recipe with the same name found
  return false;
};
