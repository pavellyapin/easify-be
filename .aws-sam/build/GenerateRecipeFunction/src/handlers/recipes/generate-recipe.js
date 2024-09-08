const { getDataFromS3, getOpenAIObject, getChatGPTPrompt, sanitizeString } = require('../utils');

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));
        const input = JSON.parse(event.body);
        console.log('Parsed input:', input);

        const [chatGPTSecret, recipeRequest] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.SECRETS_S3_KEY_NAME, 'gptSecret'),
            getDataFromS3(process.env.PROMPTS_S3_BUCKET_NAME, process.env.PROMPTS_S3_KEY_NAME, 'recipeRequest')
        ]);

        const openai = await getOpenAIObject(chatGPTSecret);

        const recipeRequestMessage = { role: 'user', content: recipeRequest };
        const contextMessage = { role: 'user', content: `Idea:${input.meal} number of servings:${input.servings} level of difficulty:${input.level}` };
        const conversationWithRecipeRequest = [contextMessage, recipeRequestMessage];

        console.log('Prepared conversation:', conversationWithRecipeRequest);
        const gptResponse = await getChatGPTPrompt(openai, conversationWithRecipeRequest, 2048,'gpt-3.5-turbo');
        console.log('GPT Response:', gptResponse);

        let recipe;
        try {
            const sanitizedContent = sanitizeString(gptResponse);
            recipe = JSON.parse(sanitizedContent);
            console.log('Parsed recipe:', recipe);
        } catch (parseError) {
            console.error('Error parsing recipe JSON:', parseError);
            throw new Error('Invalid recipe format from ChatGPT');
        }

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ recipe })
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