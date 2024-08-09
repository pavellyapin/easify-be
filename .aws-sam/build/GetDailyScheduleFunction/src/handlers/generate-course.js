const AWS = require('aws-sdk');
const { OpenAI } = require('openai');
const { Firestore } = require('@google-cloud/firestore');
AWS.config.update({ region: 'us-east-1' });

exports.lambdaHandler = async (event) => {
    console.log('Event received:', JSON.stringify(event, null, 2));
    try {
        const snsMessage = event.Records[0].Sns.Message;
        console.log('SNS Message:', snsMessage);
        const input = JSON.parse(snsMessage);
        const courseName = input.courseName;
        console.log('Course Name:', courseName);

        const [chatGPTSecret, serviceAccountKey] = await Promise.all([
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.SECRETS_S3_KEY_NAME, 'gptSecret'),
            getDataFromS3(process.env.SECRETS_S3_BUCKET_NAME, process.env.FIREBASE_ACCOUNT_S3_KEY_NAME)
        ]);

        console.log('Firestore Service Account Key:', serviceAccountKey);
        console.log('ChatGPT Secret:', chatGPTSecret);

        // Initialize Firestore with the service account key
        const firestore = new Firestore({
            projectId: serviceAccountKey.project_id,
            credentials: serviceAccountKey
        });
        const openai = await exports.getOpenAIObject(chatGPTSecret);
        console.log('OpenAI Object initialized.');

        // Generate the entire course structure
        const courseStructure = await exports.generateCourseStructure(openai, courseName);
        console.log('Generated Course Structure:', JSON.stringify(courseStructure, null, 2));

        // Save the course structure to Firestore
        await exports.saveCourseToFirestore(firestore, courseStructure);
        console.log('Course saved to Firestore.');

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ message: 'Course saved successfully' })
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
        console.log('Fetched:', jsonContent);
        return jsonContent;
    }
};

exports.getOpenAIObject = async (apiKey) => {
    console.log('Initializing OpenAI with API key.');
    const openai = new OpenAI({
        apiKey: apiKey
    });
    return openai;
};

exports.getChatGPTPrompt = async (openai, messages) => {
    console.log('Sending prompt to OpenAI:', JSON.stringify(messages, null, 2));
    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: messages,
        temperature: 1,
        max_tokens: 4095,
        top_p: 1
    });
    console.log('Received response from OpenAI:', response);
    return response.choices[0].message.content;
};

exports.generateCourseStructure = async (openai, courseName) => {
    let fullConversation = [];

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

    const initialPrompt = `Generate course about ${courseName}, return in valid json format {name,overview,level,chapters[{title,subtitle}],additionalResources,tags[]}`;
    fullConversation.push({ role: 'user', content: initialPrompt });

    const courseJson = await exports.getChatGPTPrompt(openai, fullConversation);
    console.log('Course JSON:', courseJson);
    let course;
    try {
        const sanitizedContent = sanitizeString(courseJson);
        course = JSON.parse(sanitizedContent);
    } catch (parseError) {
        console.error('Error parsing course JSON:', parseError);
        throw new Error('Invalid course format from ChatGPT');
    } 
    
    // Iterate through chapters
    for (let i = 0; i < course.chapters.length; i++) {
        fullConversation = [];
        fullConversation.push({ role: 'user', content: `Course name:${courseName} Course overview:${course.overview}`}); 
        const chapterPrompt = `Generate details for chapter with title ${course.chapters[i].title} and subtitle ${course.chapters[i].subtitle}, return in valid json format {title,subtitle,overview,topics[{title,subtitle}],tasks[]}`;
        fullConversation.push({ role: 'user', content: chapterPrompt });

        const chapterJson = await exports.getChatGPTPrompt(openai, fullConversation);
        console.log(`Chapter JSON for Chapter ${i+1}:`, chapterJson);
        let chapter;
        try {
            const sanitizedContent = sanitizeString(chapterJson);
            chapter = JSON.parse(sanitizedContent);
        } catch (parseError) {
            console.error('Error parsing chapter JSON:', parseError);
            throw new Error('Invalid chapter format from ChatGPT');
        }

        // Iterate through topics
        for (let j = 0; j < chapter.topics.length; j++) {
            fullConversation = [];
            fullConversation.push({ role: 'user', content: `Course name:${courseName} Course overview:${course.overview} chapter title:${chapter.title} chapter sub title:${chapter.subtitle} chapter overview:${chapter.overview}`});  
            const topicPrompt = `Generate details for topic with title ${chapter.topics[j].title} and subtitle ${chapter.topics[j].subtitle}, return in valid json format {title,subtitle,overview,points[{title,desc,content}],quiz}`;
            fullConversation.push({ role: 'user', content: topicPrompt });

            const topicJson = await exports.getChatGPTPrompt(openai, fullConversation);
            console.log(`Topic JSON for Topic ${j+1} in Chapter ${i+1}:`, topicJson);
            let topic;
            try {
                const sanitizedContent = sanitizeString(topicJson);
                topic = JSON.parse(sanitizedContent);
            } catch (parseError) {
                console.error('Error parsing topic JSON:', parseError);
                throw new Error('Invalid topic format from ChatGPT');
            }

          /**  for (let x = 0; x < topic.points.length; x++) {
                fullConversation = [];
                fullConversation.push({ role: 'user', content: `Course name:${courseName} Course overview:${course.overview} chapter title:${chapter.title} chapter sub title:${chapter.subtitle} chapter overview:${chapter.overview} topic title:${topic.title} topic sub title:${topic.subtitle} topic overview:${topic.overview}`});  
                const pointPrompt = `Generate details for point with title ${topic.points[x].title} and desc ${topic.points[x].desc}, return in valid json format {title,subtitle,desc,subpoints[{title,desc}]}`;
                fullConversation.push({ role: 'user', content: pointPrompt });

                const pointJson = await exports.getChatGPTPrompt(openai, fullConversation);
                console.log(`Topic JSON for Point ${x+1} in Topic ${j+1}:`, pointJson);
                let point;
                try {
                    const sanitizedContent = sanitizeString(pointJson);
                    point = JSON.parse(sanitizedContent);
                } catch (parseError) {
                    console.error('Error parsing point JSON:', parseError);
                    throw new Error('Invalid point format from ChatGPT');
                }
                topic.points[x] = point;
            } */ 

            chapter.topics[j] = topic;
        }
        course.chapters[i] = chapter;
    }

    return course;
};

exports.saveCourseToFirestore = async (firestore, courseStructure) => {
    console.log('Saving course to Firestore');
    const coursesCollection = firestore.collection('courses');
    const document = await coursesCollection.add(courseStructure);
    console.log('Course successfully saved to Firestore with ID:', document.id);
  };
