const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  verifyAndDecodeSocketToken,
  sendMessage
} = require('/opt/nodejs/utils');
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  const { requestContext, body } = event;
  const { connectionId, domainName, stage } = requestContext;
  const endpoint = `${domainName}/${stage}`;

  try {
    const startTime = new Date();
    console.log(`[${startTime.toISOString()}] Start: Received event.`);

    const [chatGPTSecret, customDayPreferences, serviceAccountKey] =
      await Promise.all([
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "customDayPreferences",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
      ]);

    console.log(
      `[${new Date().toISOString()}] Secrets and custom day preferences retrieved from S3.`,
    );

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
      console.log(`[${new Date().toISOString()}] Firebase initialized.`);
    }

    const { token, request } = JSON.parse(body);

    const authResult = await verifyAndDecodeSocketToken(token, admin);

    if (authResult.statusCode !== 200) return authResult;

    const userId = authResult.decodedToken.uid;
    console.log(
      `[${new Date().toISOString()}] Token verified for userId: ${userId}.`,
    );

    const { basicInfo, workSkills, dietNutrition, healthLifestyle, type } =
      request;
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };

    const currentDate = new Date();
    const localDate = new Date(
      currentDate.toLocaleString("en-US", { timeZone: "America/Toronto" }),
    );

    console.log(
      `[${new Date().toISOString()}] Local date and initial context created.`,
    );

    // Check if forTomorrow is true, then adjust the date
    if (basicInfo?.forTomorrow) {
      localDate.setDate(localDate.getDate() + 1); // Increment date by 1 day
    }

    const selectedDate = localDate.toLocaleDateString("en-CA", options);
    let context = `Today is ${selectedDate.replace(/,/, "")}`;

    console.log(
      `[${new Date().toISOString()}] Local date and initial context created.`,
    );

    if (basicInfo) {
      const { wakeUpTime, sleepTime, details } = basicInfo;
      if (wakeUpTime) context += ` I plan to wake up around ${wakeUpTime}.`;
      if (sleepTime) context += ` I plan to go to sleep around ${sleepTime}.`;
      if (details) context += ` Details: ${details}.`;
    }

    console.log(
      `[${new Date().toISOString()}] Basic info processed and added to context.`,
    );

    if (dietNutrition) {
      const { nutritionCategories, additionalInfo } = dietNutrition;
      if (nutritionCategories && nutritionCategories.length) {
        context += ` My preferred cuisines are ${nutritionCategories.join(", ")}.`;
      }
      if (additionalInfo) {
        context += ` My diet and nutrition preferences include: ${additionalInfo}.`;
      }
    }

    console.log(
      `[${new Date().toISOString()}] Diet and nutrition details added to context.`,
    );

    if (workSkills) {
      const { courseTags, additionalInfo } = workSkills;
      if (courseTags && courseTags.length) {
        context += ` I am interested in learning about ${courseTags.join(", ")}.`;
      }
      if (additionalInfo) {
        context += ` Additional work-related details: ${additionalInfo}.`;
      }
    }

    console.log(
      `[${new Date().toISOString()}] Work and skills details added to context.`,
    );

    if (healthLifestyle) {
      const { workoutCategories, additionalInfo } = healthLifestyle;
      if (workoutCategories && workoutCategories.length) {
        context += ` To stay active, I enjoy activities like ${workoutCategories.join(", ")}.`;
      }
      if (additionalInfo) {
        context += ` Additional lifestyle and health details: ${additionalInfo}.`;
      }
    }

    console.log(
      `[${new Date().toISOString()}] Lifestyle and health details added to context.`,
    );

    // Determine which parts of customDayPreferences to use based on the type
    let customDayContext;
    if (type === "firstHalf") {
      customDayContext = `${customDayPreferences.firstHalfScheduleRequest} ${customDayPreferences.jsonStructure}`;
    } else if (type === "secondHalf") {
      customDayContext = `${customDayPreferences.secondHalfScheduleRequest} ${customDayPreferences.jsonStructure}`;
    } else {
      customDayContext = `${customDayPreferences.scheduleRequest} ${customDayPreferences.jsonStructure}`;
    }

    const contextMessage = {
      role: "user",
      content: `${context} ${customDayContext}`,
    };

    console.log(
      `[${new Date().toISOString()}] Prepared context message for GPT request.`,
    );

    const openai = await getOpenAIObject(chatGPTSecret);
    console.log(
      `[${new Date().toISOString()}] Initialized OpenAI object with provided secret.`,
    );

    // Determine max tokens based on the type parameter
    let maxTokens = 1500; // Default value
    let model = "gpt-4o-mini";
    if (type === "full") {
      model = "gpt-4o-mini";
      maxTokens = 2048;
    } else if (type === "expanded") {
      model = "gpt-4o-mini";
      maxTokens = 4096;
    } else if (type === "smart") {
      model = "o1-mini";
      maxTokens = 8192;
    }

    const gptResponse = await getChatGPTPrompt(
      openai,
      [contextMessage],
      maxTokens,
      model,
    );
    console.log(
      `[${new Date().toISOString()}] Received response from GPT model.`,
    );

    let schedule;
    try {
      const sanitizedContent = sanitizeString(gptResponse);
      schedule = JSON.parse(sanitizedContent);
      // Add type and model to the schedule object
      schedule.type = type;
      schedule.model = model;
      schedule.id = localDate.toISOString().split("T")[0];
      console.log(
        `[${new Date().toISOString()}] Parsed GPT response and converted to JSON format.`,
      );
    } catch (parseError) {
      console.error(
        `[${new Date().toISOString()}] Error parsing GPT response to JSON:`,
        parseError,
      );
      throw new Error("Invalid schedule format from ChatGPT");
    }

    // Save the schedule to Firestore
    exports.saveScheduleToFirestore(
      admin.firestore(),
      schedule,
      userId,
      localDate,
      type,
      "gpt-4o-mini",
    );
    console.log(`[${new Date().toISOString()}] Schedule saved to Firestore.`);

    console.log(
      `[${new Date().toISOString()}] Completed processing in lambdaHandler.`,
    );
    await sendMessage(connectionId, endpoint, {
      status: "success",
      schedule,
    });
    return { statusCode: 200 };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error encountered:`, error);
    await sendMessage(connectionId, endpoint, {
      status: "error",
      message: error.message,
    });
    return { statusCode: 500 };
  }
};

exports.saveScheduleToFirestore = async (
  firestore,
  schedule,
  userId,
  localDate,
  type,
  model,
) => {
  try {
    const startTime = new Date();
    console.log(
      `[${startTime.toISOString()}] Starting save schedule to Firestore.`,
    );

    // Use the localDate calculated above (today or tomorrow)
    const dateToSave = localDate.toISOString().split("T")[0];

    const scheduleRef = firestore
      .collection("users")
      .doc(userId)
      .collection("schedules")
      .doc(dateToSave);

    await scheduleRef.set({
      ...schedule,
      id: dateToSave,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      type,
      model,
    });

    console.log(
      `[${new Date().toISOString()}] Schedule saved successfully in Firestore.`,
    );
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Error saving schedule to Firestore:`,
      error,
    );
    throw new Error("Failed to save the schedule.");
  }
};
