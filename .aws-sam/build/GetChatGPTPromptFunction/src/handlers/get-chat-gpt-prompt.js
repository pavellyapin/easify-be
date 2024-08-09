const AWS = require('aws-sdk');
const { OpenAI } = require('openai');
AWS.config.update({region: 'us-east-1'});

exports.lambdaHandler = async (event) => {
    try {
        const input = JSON.parse(event.body);
        const [chatGPTSecret] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.SECRETS_S3_KEY_NAME, 'gptSecret')
        ]);

        const openai = await exports.getOpenAIObject(chatGPTSecret);
        const gptResponse = await exports.getChatGPTPrompt(openai, input.conversation);
        console.log(gptResponse);
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify(gptResponse)
        };
    } catch (error) {
        console.log(error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify(error)
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
    const openai = new OpenAI({
        apiKey: apiKey
    });
    return openai;
}

exports.getChatGPTPrompt = async (openai, conversation) => {
    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: conversation,
        temperature: 1,
        max_tokens: 256,
        top_p: 1
    });
    return response.choices[0].message.content;
}
