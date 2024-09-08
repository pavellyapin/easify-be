const { getDataFromS3, getOpenAIObject, getChatGPTPrompt, sanitizeString } = require('../utils');
const admin = require('firebase-admin');

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));

        // Parse the SNS message containing an array of workout names
        const snsMessage = event.Records[0].Sns.Message;
        const workouts = JSON.parse(snsMessage).workouts; // Assuming the SNS message is a JSON string array of workout names

        // Fetch necessary secrets and service account keys
        const [chatGPTSecret, workoutRequest, serviceAccountKey] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.SECRETS_S3_KEY_NAME, 'gptSecret'),
            getDataFromS3(process.env.PROMPTS_S3_BUCKET_NAME, process.env.PROMPTS_S3_KEY_NAME, 'workoutRequest'),
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.FIREBASE_ACCOUNT_S3_KEY_NAME)
        ]);

        // Initialize Firebase Admin with the service account key
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccountKey)
            });
        }

        const firestore = admin.firestore();

        const openai = await getOpenAIObject(chatGPTSecret);

        // Loop through the array of workout names
        for (const workoutMsg of workouts) {
            console.log(`Processing workout: ${workoutMsg.name}`);

            // Check if the workout with the same name already exists in Firestore
            const existingWorkout = await checkIfWorkoutExists(firestore, workoutMsg.name);
            if (existingWorkout) {
                console.log(`Workout with name "${workoutMsg.name}" already exists. Skipping generation.`);
                continue;
            }

            const workoutRequestMessage = { role: 'user', content: `${workoutRequest} Workout name: ${workoutMsg.name}` };
            const contextMessage = { role: 'user', content: `Generate a workout for: ${workoutMsg.name}` };
            const conversationWithWorkoutRequest = [contextMessage, workoutRequestMessage];

            console.log('Prepared conversation:', conversationWithWorkoutRequest);
            const gptResponse = await getChatGPTPrompt(openai, conversationWithWorkoutRequest, 2048,'gpt-3.5-turbo');
            console.log('GPT Response:', gptResponse);

            let workout;
            try {
                const sanitizedContent = sanitizeString(gptResponse);
                workout = JSON.parse(sanitizedContent);
                console.log('Parsed workout:', workout);

                // Save the workout structure to Firestore
                await exports.saveWorkoutToFirestore(firestore, workout);
            } catch (error) {
                console.error('Error while saving workout:', error);
                continue; // Skip to the next workout in case of error
            }
        }

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ message: 'Workouts processed successfully.' })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ error: error.message })
        };
    }
};

exports.saveWorkoutToFirestore = async (firestore, workout) => {
    console.log('Saving workout to Firestore');
    const workoutsCollection = firestore.collection('workouts');
    // Normalize the tags to lowercase before saving
    if (workout.tags && Array.isArray(workout.tags)) {
        workout.tags = workout.tags.map(tag => tag.toLowerCase());
    }
    // Add the createdDate field with the current date
    workout.createdDate = new Date().toISOString();
    const document = await workoutsCollection.add(workout);
    console.log('Workout successfully saved to Firestore with ID:', document.id);
};

// Function to check if a workout with the same name already exists
const checkIfWorkoutExists = async (firestore, workoutName) => {
    const workoutsCollection = firestore.collection('workouts');
    const querySnapshot = await workoutsCollection.where('name', '==', workoutName).get();

    if (!querySnapshot.empty) {
        // Workout with the same name already exists
        return true;
    }

    // No workout with the same name found
    return false;
};