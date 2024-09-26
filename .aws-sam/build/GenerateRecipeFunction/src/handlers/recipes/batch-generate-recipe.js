const { getDataFromS3, getOpenAIObject, getChatGPTPrompt, generateImageAndSavetoStorage, sanitizeString } = require('../utils');
const { HEADERS } = require('../const');
const admin = require('firebase-admin');

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));

        // Parse the SNS message containing an array of recipe names
        const snsMessage = event.Records[0].Sns.Message;
        const recipes = JSON.parse(snsMessage).recipes; // Assuming the SNS message is a JSON string array of recipe names

        // Fetch necessary secrets and service account keys
        const [chatGPTSecret, recipeRequest, serviceAccountKey] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.SECRETS_S3_KEY_NAME, 'gptSecret'),
            getDataFromS3(process.env.PROMPTS_S3_BUCKET_NAME, process.env.PROMPTS_S3_KEY_NAME, 'recipeRequest'),
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.FIREBASE_ACCOUNT_S3_KEY_NAME)
        ]);

        // Initialize Firebase Admin with the service account key
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccountKey),
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET // Use the Firebase Storage bucket name
            });
        }

        const firestore = admin.firestore();
        const bucket = admin.storage().bucket();

        const openai = await getOpenAIObject(chatGPTSecret);

        // Loop through the array of recipe names
        for (const recipeMsg of recipes) {
            console.log(`Processing recipe: ${recipeMsg.name}`);

            // Check if the recipe with the same name already exists in Firestore
            const existingRecipe = await checkIfRecipeExists(firestore, recipeMsg.name);
            if (existingRecipe) {
                console.log(`Recipe with name "${recipeMsg.name}" already exists. Skipping generation.`);
                continue;
            }

            const recipeRequestMessage = { role: 'user', content: `${recipeRequest} Recipe name: ${recipeMsg.name}` };
            const contextMessage = { role: 'user', content: `Generate a recipe for: ${recipeMsg.name}` };
            const conversationWithRecipeRequest = [contextMessage, recipeRequestMessage];

            console.log('Prepared conversation:', conversationWithRecipeRequest);
            const gptResponse = await getChatGPTPrompt(openai, conversationWithRecipeRequest, 2048,'gpt-3.5-turbo');
            console.log('GPT Response:', gptResponse);

            let recipe;
            try {
                const sanitizedContent = sanitizeString(gptResponse);
                recipe = JSON.parse(sanitizedContent);
                console.log('Parsed recipe:', recipe);

                // Generate an image based on the recipe description
                const imagePrompt = recipe.description + ". Photograph style"; // Use the description for image generation
                const imageUrl = await generateImageAndSavetoStorage(openai, bucket, imagePrompt, recipeMsg);
                
                // Attach the Firebase Storage URL to the recipe object
                recipe.image = imageUrl;

                // Save the recipe structure to Firestore
                await exports.saveRecipeToFirestore(firestore, recipe);
            } catch (error) {
                console.error('Error while saving recipe:', error);
                continue; // Skip to the next recipe in case of error
            }
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ message: 'Recipes processed successfully.' })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: error.message })
        };
    }
};

exports.saveRecipeToFirestore = async (firestore, recipe) => {
    console.log('Saving recipe to Firestore');
    const recipesCollection = firestore.collection('recipes');
    // Normalize the tags to lowercase before saving
    if (recipe.tags && Array.isArray(recipe.tags)) {
        recipe.tags = recipe.tags.map(tag => tag.toLowerCase());
    }
    // Normalize the ingredient names to lowercase before saving
    if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
        recipe.ingredients = recipe.ingredients.map(ingredient => {
            return {
                ...ingredient,
                name: ingredient.name.trim().toLowerCase() // Normalize ingredient name
            };
        });
    }
    // Add the createdDate field with the current date
    recipe.createdDate = new Date().toISOString();
    const document = await recipesCollection.add(recipe);
    console.log('Recipe successfully saved to Firestore with ID:', document.id);
};

// Function to check if a recipe with the same name already exists
const checkIfRecipeExists = async (firestore, recipeName) => {
    const recipesCollection = firestore.collection('recipes');
    const querySnapshot = await recipesCollection.where('name', '==', recipeName).get();

    if (!querySnapshot.empty) {
        // Recipe with the same name already exists
        return true;
    }

    // No recipe with the same name found
    return false;
};