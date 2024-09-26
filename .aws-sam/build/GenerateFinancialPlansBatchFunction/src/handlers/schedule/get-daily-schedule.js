const { getDataFromS3, getOpenAIObject, getChatGPTPrompt, sanitizeString, verifyAndDecodeToken } = require('../utils');
const admin = require('firebase-admin');
const { HEADERS } = require('../const');

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));

        const [chatGPTSecret, scheduleRequest, serviceAccountKey] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.SECRETS_S3_KEY_NAME, 'gptSecret'),
            getDataFromS3(process.env.PROMPTS_S3_BUCKET_NAME, process.env.PROMPTS_S3_KEY_NAME, 'scheduleRequest'),
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.FIREBASE_ACCOUNT_S3_KEY_NAME)
        ]);

        // Initialize Firebase Admin with the service account key
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccountKey)
            });
        }

        // Verify and decode the token
        const authResult = await verifyAndDecodeToken(event, admin);
        if (authResult.statusCode !== 200) return authResult;

        const userId = authResult.decodedToken.uid;

        // Fetch user data from Firestore
        const userDoc = await admin.firestore().collection('users').doc(userId).get();
        if (!userDoc.exists) {
            throw new Error('User not found');
        }
        const userData = userDoc.data();

        const options = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        };

        // Forcefully set the date to reflect local time instead of UTC
        const currentDate = new Date();
        const localDate = new Date(currentDate.toLocaleString('en-US', { timeZone: 'America/Toronto' })); // Set to your local time zone

        const today = localDate.toLocaleDateString('en-CA', options);
        let context = `Today is ${today.replace(/,/, '')}`;
        
        // Check basicInfo map
        if (userData.basicInfo) {
            const { name, city, gender, sleepTime, wakeUpTime } = userData.basicInfo;
            if (name) context += `My name is ${name}. `;
            if (city) context += `I live in ${city}. `;
            if (gender) context += `I identify as ${gender}. `;
            if (wakeUpTime) context += `I usually wake up around ${wakeUpTime}. `;
            if (sleepTime) context += `I usually go to sleep around ${sleepTime}. `;
        }
        // Check dietNutrition map
        if (userData.dietNutrition) {
            const { vegetarian, vegan, glutenFree, lactoseIntolerant, nutritionCategories, recipeTags } = userData.dietNutrition;
            
            // Array to store food restrictions
            let foodRestrictions = [];
            
            if (vegetarian) foodRestrictions.push('I am vegetarian');
            if (vegan) foodRestrictions.push('I am vegan');
            if (glutenFree) foodRestrictions.push('I am gluten-free');
            if (lactoseIntolerant) foodRestrictions.push('I am lactose intolerant');

            // Add default message if no restrictions are true
            if (foodRestrictions.length === 0) {
                context += `I don't have any food restrictions. `;
            } else {
                context += `${foodRestrictions.join(', ')}. `;
            }

            // Add favorite cuisines and foods
            if (nutritionCategories && nutritionCategories.length) {
                context += `Some of my favorite cuisines are ${nutritionCategories.join(', ')}. `;
            }
            if (recipeTags && recipeTags.length) {
                context += `Some foods I like to eat are ${recipeTags.join(', ')}. `;
            }
        }

        // Check financialPlanning map
        if (userData.financialPlanning) {
            const { planCategories, planTags } = userData.financialPlanning;
            if (planCategories && planCategories.length) {
                context += `I would like to learn and hear advice about ${planCategories.join(', ')}. `;
            }
            if (planTags && planTags.length) {
                context += `Some financial planing topics I am interested in are ${planTags.join(', ')}. `;
            }
        }

        // Check lifestyleHealth map
        if (userData.lifestyleHealth) {
            const { kids, martialStatus, workoutCategories, workoutTags } = userData.lifestyleHealth;
            if (martialStatus) context += `When comes to relationships I am ${martialStatus}. `;
            if (kids) context += `I do have kids: ${kids}. `;
            if (workoutCategories && workoutCategories.length) {
                context += `To stay active some of the activities I am into are ${workoutCategories.join(', ')}. `;
            }
            if (workoutTags && workoutTags.length) {
                context += `To stay healthy and in good shape I would like to work on ${workoutTags.join(', ')}. `;
            }
        }

        // Check workSkills map
        if (userData.workSkills) {
            const { occupation, workStatus, hybridStatus, industries, courseTags } = userData.workSkills;

            if (occupation) context += `I work as a ${occupation}. `;
            if (workStatus) context += `My work status is ${workStatus}. I typically work 5 days a week and take weekends off. `;

            // Add hybrid status with dynamic text
            if (hybridStatus) {
                if (hybridStatus === 'remote') {
                    context += `I work remotely. `;
                } else if (hybridStatus === 'in office') {
                    context += `I work in the office. `;
                } else if (hybridStatus === 'hybrid') {
                    context += `I have a hybrid work schedule, splitting my time between remote work and office. `;
                }
            }

            // Add industries
            if (industries && industries.length) {
                context += `Some of the industries I am interested in are ${industries.join(', ')}. `;
            }

            // Add course tags
            if (courseTags && courseTags.length) {
                context += `Some topics I would like to learn more about are ${courseTags.join(', ')}. `;
            }
        }

        // Check moreInfo map
        if (userData.moreInfo) {
            const { additionalInfo } = userData.moreInfo;
            if (additionalInfo) context += `Additional info about me: ${additionalInfo}. `;
        }

        const contextMessage = { role: 'user', content: `${context} ${scheduleRequest}` };
        const conversationWithScheduleRequest = [contextMessage];

        console.log('Prepared conversation:', conversationWithScheduleRequest);

        // Send request to OpenAI
        const openai = await getOpenAIObject(chatGPTSecret);
        const gptResponse = await getChatGPTPrompt(openai, conversationWithScheduleRequest, 4096, 'gpt-4o-mini');
        console.log('GPT Response:', gptResponse);

        let schedule;
        try {
            const sanitizedContent = sanitizeString(gptResponse);
            schedule = JSON.parse(sanitizedContent);
            console.log('Parsed schedule:', schedule);
        } catch (parseError) {
            console.error('Error parsing schedule JSON:', parseError);
            throw new Error('Invalid schedule format from ChatGPT');
        }

        await exports.saveScheduleToFirestore(admin.firestore(), schedule ,userId);

        return {
            statusCode: 200,
            headers: HEADERS
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

exports.saveScheduleToFirestore = async (firestore, schedule, userId) => {
    try {
        const currentDate = new Date();
        const localDate = new Date(currentDate.toLocaleString('en-US', { timeZone: 'America/Toronto' })); // Set to your local time zone
        const today = localDate.toLocaleDateString('en-CA').split('T')[0];
        // Create a reference to the user's schedules sub-collection
        const scheduleRef = firestore.collection('users').doc(userId).collection('schedules').doc(today);

        // Add an id field and save the schedule
        await scheduleRef.set({
            ...schedule, // Spread the schedule data
            id: today, // Set the id to the formatted date
            createdAt: admin.firestore.FieldValue.serverTimestamp() // Add a timestamp for when the schedule was saved
        });

        console.log('Schedule saved successfully.');
    } catch (error) {
        console.error('Error saving schedule:', error);
        throw new Error('Failed to save the schedule.');
    }
};