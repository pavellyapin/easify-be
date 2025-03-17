const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  generateImageAndSavetoStorage,
} = require("/opt/nodejs/utils");
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  console.log("Event received:", JSON.stringify(event, null, 2));
  try {
    const snsMessage = event.Records[0].Sns.Message;
    const { courseName } = JSON.parse(snsMessage);
    console.log("Processing course:", courseName);

    const [chatGPTSecret, serviceAccountKey, courseImagePrompt] =
      await Promise.all([
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "courseImageRequest",
        ),
      ]);

    console.log("Firestore Service Account Key:", serviceAccountKey);
    console.log("ChatGPT Secret:", chatGPTSecret);

    // Initialize Firebase Admin with the service account key
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET, // Use the Firebase Storage bucket name
      });
    }
    const firestore = admin.firestore();
    const bucket = admin.storage().bucket();

    const openai = await getOpenAIObject(chatGPTSecret);
    console.log("OpenAI Object initialized.");

    // Check if course already exists in Firestore
    const existingCourse = await checkIfCourseExists(firestore, courseName);
    if (existingCourse) {
      console.log(`Course "${courseName}" already exists. Skipping.`);
      return;
    }

    try {
      // Generate the entire course structure
      const courseStructure = await exports.generateCourseStructure(
        openai,
        courseName,
      );

      // Check if image generation is enabled
      const enableImageGen = process.env.ENABLE_IMAGE_GEN === "true";
      let imageUrl = "";

      if (enableImageGen) {
        try {
          const coursePrompt = courseImagePrompt.replace("{name}", courseName);

          // Try generating the image
          imageUrl = await generateImageAndSavetoStorage(
            openai,
            bucket,
            coursePrompt,
            { name: courseName },
            "dall-e-3",
          );
          console.log(
            "Image generated successfully for the course:",
            courseName,
          );
        } catch (imageError) {
          console.error(
            "Image generation failed for the course:",
            courseName,
            imageError,
          );
          // Optionally, you can set a default placeholder image URL
          imageUrl = "";
          console.log("Using placeholder image for the course:", courseName);
        }
      }
      courseStructure.image = imageUrl;
      // Save the course structure to Firestore
      await exports.saveCourseToFirestore(firestore, courseStructure);
      console.log("Course saved to Firestore:", courseStructure);
    } catch (error) {
      console.error("Error while generating or saving the course:", error);
      return;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Course saved successfully" }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.generateCourseStructure = async (openai, courseName) => {
  let fullConversation = [];

  const initialPrompt = `Generate an interesting course about ${courseName}, return in valid json format {name,category,overview,level(beginner/intermediate/advanced),chapters[{title,subtitle}],additionalResources[string],tags[string]}`;
  fullConversation.push({ role: "user", content: initialPrompt });

  const courseJson = await getChatGPTPrompt(
    openai,
    fullConversation,
    1024,
    "gpt-4o-mini",
  );
  console.log("Course JSON:", courseJson);
  let course;
  try {
    const sanitizedContent = sanitizeString(courseJson);
    course = JSON.parse(sanitizedContent);
  } catch (parseError) {
    console.error("Error parsing course JSON:", parseError);
    throw new Error("Invalid course format from ChatGPT");
  }

  // Iterate through chapters
  for (let i = 0; i < course.chapters.length; i++) {
    fullConversation = [];
    fullConversation.push({
      role: "user",
      content: `Course name:${courseName} Course overview:${course.overview}`,
    });
    const chapterPrompt = `Generate interesting content for chapter with title ${course.chapters[i].title} and subtitle ${course.chapters[i].subtitle}, return in valid json format {title,subtitle,overview,topics[{title,subtitle}],tasks[string]}`;
    fullConversation.push({ role: "user", content: chapterPrompt });

    const chapterJson = await getChatGPTPrompt(
      openai,
      fullConversation,
      1024,
      "gpt-4o-mini",
    );
    console.log(`Chapter JSON for Chapter ${i + 1}:`, chapterJson);
    let chapter;
    try {
      const sanitizedContent = sanitizeString(chapterJson);
      chapter = JSON.parse(sanitizedContent);
    } catch (parseError) {
      console.error("Error parsing chapter JSON:", parseError);
      throw new Error("Invalid chapter format from ChatGPT");
    }

    // Iterate through topics
    for (let j = 0; j < chapter.topics.length; j++) {
      fullConversation = [];
      fullConversation.push({
        role: "user",
        content: `Course name:${courseName} Course overview:${course.overview} chapter title:${chapter.title} chapter sub title:${chapter.subtitle} chapter overview:${chapter.overview}`,
      });
      const topicPrompt = `Generate interesting content for topic with title ${chapter.topics[j].title} and subtitle ${chapter.topics[j].subtitle}, return in valid json format {title,subtitle,overview,points[{title,desc,content(string)}]}`;
      fullConversation.push({ role: "user", content: topicPrompt });

      const topicJson = await getChatGPTPrompt(
        openai,
        fullConversation,
        2048,
        "gpt-4o-mini",
      );
      console.log(
        `Topic JSON for Topic ${j + 1} in Chapter ${i + 1}:`,
        topicJson,
      );
      let topic;
      try {
        const sanitizedContent = sanitizeString(topicJson);
        topic = JSON.parse(sanitizedContent);
      } catch (parseError) {
        console.error("Error parsing topic JSON:", parseError);
        throw new Error("Invalid topic format from ChatGPT");
      }

      chapter.topics[j] = topic;
    }
    course.chapters[i] = chapter;
  }

  return course;
};

exports.saveCourseToFirestore = async (firestore, courseStructure) => {
  console.log("Saving course to Firestore");

  // Check if tags is a string, and convert it to an array if necessary
  if (courseStructure.tags && typeof courseStructure.tags === "string") {
    courseStructure.tags = courseStructure.tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase());
  } else if (Array.isArray(courseStructure.tags)) {
    // Normalize the tags to lowercase if already an array
    courseStructure.tags = courseStructure.tags.map((tag) => tag.toLowerCase());
  }

  if (courseStructure.category) {
    courseStructure.category = courseStructure.category.trim().toLowerCase();
  }

  if (courseStructure.level) {
    // Possible valid values for level field
    const validLevels = ["beginner", "intermediate", "advanced"];
    let level = courseStructure.level.toLowerCase(); // Normalize level to lowercase
    // If the level is not one of the valid values, set to "intermediate"
    if (!validLevels.includes(level)) {
      level = "intermediate";
    } else {
      courseStructure.level = level;
    }
  }

  // Add the createdDate field with the current date
  courseStructure.createdDate = new Date().toISOString();

  const coursesCollection = firestore.collection("courses");
  const document = await coursesCollection.add(courseStructure);
  console.log("Course successfully saved to Firestore with ID:", document.id);
};

// Function to check if a course with the same name already exists
const checkIfCourseExists = async (firestore, courseName) => {
  const coursesCollection = firestore.collection("courses");
  const querySnapshot = await coursesCollection
    .where("name", "==", courseName)
    .get();

  if (!querySnapshot.empty) {
    // Course with the same name already exists
    return true;
  }

  // No course with the same name found
  return false;
};
