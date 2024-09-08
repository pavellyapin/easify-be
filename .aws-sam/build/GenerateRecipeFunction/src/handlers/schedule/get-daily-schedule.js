const { getDataFromS3, getOpenAIObject, getChatGPTPrompt, sanitizeString , verifyAndDecodeToken } = require('../utils');
const admin = require('firebase-admin');

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));


        const [chatGPTSecret, scheduleRequest,serviceAccountKey] = await Promise.all([
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

        // Handle unauthorized or forbidden responses
        if (authResult.statusCode !== 200) {
            return authResult;  // Return the response directly
        }

        const input = JSON.parse(event.body);
        console.log('Parsed input:', input);
        const openai = await getOpenAIObject(chatGPTSecret);
        const concatenatedMessages = input.conversation
            .map(msg => msg.content)
            .join(' ');

        const scheduleRequestMessage = { role: 'user', content: scheduleRequest };
        const contextMessage = { role: 'user', content: concatenatedMessages };
        const conversationWithScheduleRequest = [contextMessage,scheduleRequestMessage];

        console.log('Prepared conversation:', conversationWithScheduleRequest);
        const gptResponse = await getChatGPTPrompt(openai, conversationWithScheduleRequest,4096,'gpt-4o-mini');
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

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ schedule })
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
}