const { getDataFromS3, getOpenAIObject, getChatGPTPrompt, sanitizeString } = require('../utils');
const { Firestore } = require('@google-cloud/firestore');

exports.lambdaHandler = async (event) => {
    console.log('Event received:', JSON.stringify(event, null, 2));
    try {
        const snsMessage = event.Records[0].Sns.Message;
        console.log('SNS Message:', snsMessage);
        const input = JSON.parse(snsMessage);
        const courses = input.courses;

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
        const openai = await getOpenAIObject(chatGPTSecret);
        console.log('OpenAI Object initialized.');

        for (const course of courses) {
            console.log('Course Name:', course);

            // Check if the course with the same name already exists in Firestore
            const existingCourse = await checkIfCourseExists(firestore, course);
            if (existingCourse) {
                console.log(`Course with name "${course}" already exists. Skipping generation.`);
                continue;
            }

            try {
                // Generate the entire course structure
                const courseStructure = await exports.generateCourseStructure(openai, course);
                // Save the course structure to Firestore
                await exports.saveCourseToFirestore(firestore, courseStructure);
                console.log('Course saved to Firestore:', course);
            } catch (error) {
                console.error('Error while generating course:', error);
                continue;
            }
        }

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

exports.generateCourseStructure = async (openai, courseName) => {
    let fullConversation = [];

    const initialPrompt = `Generate course about ${courseName}, return in valid json format {name,overview,level,chapters[{title,subtitle}],additionalResources,tags[]}`;
    fullConversation.push({ role: 'user', content: initialPrompt });

    const courseJson = await getChatGPTPrompt(openai, fullConversation, 4095,'gpt-3.5-turbo');
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

        const chapterJson = await getChatGPTPrompt(openai, fullConversation, 4095,'gpt-3.5-turbo');
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

            const topicJson = await getChatGPTPrompt(openai, fullConversation, 4095,'gpt-3.5-turbo');
            console.log(`Topic JSON for Topic ${j+1} in Chapter ${i+1}:`, topicJson);
            let topic;
            try {
                const sanitizedContent = sanitizeString(topicJson);
                topic = JSON.parse(sanitizedContent);
            } catch (parseError) {
                console.error('Error parsing topic JSON:', parseError);
                throw new Error('Invalid topic format from ChatGPT');
            }

            chapter.topics[j] = topic;
        }
        course.chapters[i] = chapter;
    }

    return course;
};

exports.saveCourseToFirestore = async (firestore, courseStructure) => {
    console.log('Saving course to Firestore');

    // Normalize the tags to lowercase before saving
    if (courseStructure.tags && Array.isArray(courseStructure.tags)) {
        courseStructure.tags = courseStructure.tags.map(tag => tag.toLowerCase());
    }

    // Add the createdDate field with the current date
    courseStructure.createdDate = new Date().toISOString();

    const coursesCollection = firestore.collection('courses');
    const document = await coursesCollection.add(courseStructure);
    console.log('Course successfully saved to Firestore with ID:', document.id);
};

// Function to check if a course with the same name already exists
const checkIfCourseExists = async (firestore, courseName) => {
    const coursesCollection = firestore.collection('courses');
    const querySnapshot = await coursesCollection.where('name', '==', courseName).get();

    if (!querySnapshot.empty) {
        // Course with the same name already exists
        return true;
    }

    // No course with the same name found
    return false;
};