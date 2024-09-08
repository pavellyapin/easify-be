const AWS = require('aws-sdk');
const { OpenAI } = require('openai');
AWS.config.update({ region: 'us-east-1' });
const axios = require('axios');

const getDataFromS3 = async (bucketName, keyName, dataKey) => {
    console.log(`Fetching ${dataKey} from S3 bucket: ${bucketName}, key: ${keyName}`);
    const s3 = new AWS.S3();
    const params = {
        Bucket: bucketName,
        Key: keyName
    };
    const data = await s3.getObject(params).promise();
    const jsonContent = JSON.parse(data.Body.toString('utf-8'));
    if (dataKey) {
        console.log(`Fetched ${dataKey}:`, jsonContent[dataKey]);
        return jsonContent[dataKey];
    } else {
        console.log(`Fetched ${dataKey}:`, jsonContent[dataKey]);
        return jsonContent;
    }

};

const getOpenAIObject = async (apiKey) => {
    console.log('Initializing OpenAI object');
    const openai = new OpenAI({
        apiKey: apiKey
    });
    return openai;
}

const getChatGPTPrompt = async (openai, conversation,max_tokens,model) => {
    console.log('Sending conversation to OpenAI:', conversation);
    const response = await openai.chat.completions.create({
        model: model,
        messages: conversation,
        temperature: 0.7,
        max_tokens: max_tokens,
        top_p: 1
    });
    console.log('Received response from OpenAI:', response);
    return response.choices[0].message.content;
}

const generateImageAndSavetoStorage = async (openai, bucket, imagePrompt, object) => {
    let imageUrl = "";
    try {
        console.log(`Starting image generation for: ${object.name}`);

        if (object.image) {
            imageUrl = object.image;
            console.log(`Using provided image URL for ${object.name}: ${imageUrl}`);
        } else {
            const imageResponse = await openai.images.generate({
                model: "dall-e-2",
                prompt: imagePrompt,
                quality: "standard",
                n: 1,
                size: "512x512"
            });

            if (!imageResponse.data || !imageResponse.data[0] || !imageResponse.data[0].url) {
                throw new Error('Failed to generate image URL from OpenAI response.');
            }

            imageUrl = imageResponse.data[0].url;
            console.log(`Generated image URL for ${object.name}: ${imageUrl}`);
        }

        // Download the image from the generated URL
        console.log(`Downloading image from URL for ${object.name}: ${imageUrl}`);
        const imageResponseBuffer = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(imageResponseBuffer.data, 'binary');

        // Create a unique filename
        const fileName = `${object.name.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}.png`;
        console.log(`Uploading image to Firebase Storage as ${fileName}`);

        // Upload the image to Firebase Storage
        const file = bucket.file(fileName);
        await file.save(imageBuffer, {
            metadata: { contentType: 'image/png' }
        });

        const firebaseImageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        console.log(`Firebase Storage image URL for ${object.name}: ${firebaseImageUrl}`);

        return firebaseImageUrl;

    } catch (error) {
        console.error(`Error processing image for ${object.name}:`, error.message);
        // Add additional logging for debugging
        console.error('Detailed error:', error);
        throw new Error(`Failed to generate and save image for ${object.name}`);
    }
};

const sanitizeString = (str) => {
    let sanitized = str.trim();
    sanitized = sanitized.replace(/^[^{]*|[^}]*$/g, '');
    if (sanitized.charAt(0) !== '{') {
        sanitized = '{' + sanitized;
    }
    if (sanitized.charAt(sanitized.length - 1) !== '}') {
        sanitized = sanitized + '}';
    }
    return sanitized;
};

const verifyAndDecodeToken = async (event, admin) => {
    const idToken = event.headers.Authorization;

    if (!idToken) {
        return {
            statusCode: 401,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ message: 'Unauthorized' }),
        };
    }

    try {
        // Verify the ID token using Firebase Admin SDK
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        console.log('Decoded token:', decodedToken);
        return {
            statusCode: 200,
            decodedToken,  // Return the decoded token for further processing
        };
    } catch (error) {
        console.error('Error verifying ID token:', error);
        return {
            statusCode: 403,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ message: 'Forbidden' }),
        };
    }
};

module.exports = {
    getDataFromS3,
    getOpenAIObject,
    getChatGPTPrompt,
    generateImageAndSavetoStorage,
    sanitizeString,
    verifyAndDecodeToken
};