const AWS = require('aws-sdk');
const { OpenAI } = require('openai');
AWS.config.update({ region: 'us-east-1' });

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));
        const input = JSON.parse(event.body);
        console.log('Parsed input:', input);

        const [chatGPTSecret, scheduleRequest] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.SECRETS_S3_KEY_NAME, 'gptSecret'),
            getDataFromS3(process.env.PROMPTS_S3_BUCKET_NAME, process.env.PROMPTS_S3_KEY_NAME, 'scheduleRequest')
        ]);

        const openai = await exports.getOpenAIObject(chatGPTSecret);
        const concatenatedMessages = input.conversation
            .map(msg => msg.content)
            .join(' ');

        // Prepend the fetched request for a daily schedule
        const scheduleRequestMessage = { role: 'user', content: scheduleRequest };
        const contextMessage = { role: 'user', content: concatenatedMessages };
        const conversationWithScheduleRequest = [scheduleRequestMessage, contextMessage];

        console.log('Prepared conversation:', conversationWithScheduleRequest);
        const gptResponse = await exports.getChatGPTPrompt(openai, conversationWithScheduleRequest);
        console.log('GPT Response:', gptResponse);

        const sanitizeString = (str) => {
            // Trim leading and trailing spaces
            let sanitized = str.trim();
        
            // Remove all characters before the first '{' and after the last '}'
            sanitized = sanitized.replace(/^[^{]*|[^}]*$/g, '');
        
            // Ensure there's an opening '{' if missing
            if (sanitized.charAt(0) !== '{') {
                sanitized = '{' + sanitized;
            }
        
            // Ensure there's a closing '}' if missing
            if (sanitized.charAt(sanitized.length - 1) !== '}') {
                sanitized = sanitized + '}';
            }
        
            return sanitized;
        };

        // Handle special characters and parse JSON string
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

const getDataFromS3 = async (bucketName, keyName, dataKey) => {
    console.log(`Fetching ${dataKey} from S3 bucket: ${bucketName}, key: ${keyName}`);
    const s3 = new AWS.S3();
    const params = {
        Bucket: bucketName,
        Key: keyName
    };
    const data = await s3.getObject(params).promise();
    const jsonContent = JSON.parse(data.Body.toString('utf-8'));
    console.log(`Fetched ${dataKey}:`, jsonContent[dataKey]);
    return jsonContent[dataKey];
};

exports.getOpenAIObject = async (apiKey) => {
    console.log('Initializing OpenAI object');
    const openai = new OpenAI({
        apiKey: apiKey
    });
    return openai;
}

exports.getChatGPTPrompt = async (openai, conversation) => {
    console.log('Sending conversation to OpenAI:', conversation);
    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: conversation,
        temperature: 0.7,
        max_tokens: 1024,
        top_p: 1
    });
    console.log('Received response from OpenAI:', response);
    return response.choices[0].message.content;
}
