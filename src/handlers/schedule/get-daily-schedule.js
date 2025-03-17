const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  verifyAndDecodeSocketToken,
  sendMessage,
} = require("/opt/nodejs/utils");
const admin = require("firebase-admin");

const determineDate = (forTomorrow) => {
  const currentDate = new Date();
  if (forTomorrow) currentDate.setDate(currentDate.getDate() + 1); // Move to tomorrow
  return new Date(
    currentDate.toLocaleString("en-US", { timeZone: "America/Toronto" }),
  ).toLocaleDateString("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};

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

    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .get();
    console.log(
      `[${new Date().toISOString()}] Fetched user data from Firestore for userId: ${userId}.`,
    );

    if (!userDoc.exists) {
      throw new Error("User not found");
    }
    const userData = userDoc.data();

    const scheduleDateString = determineDate(request.forTomorrow);
    let context = `Today is ${scheduleDateString.replace(/,/, "")}. `;

    console.log(
      `[${new Date().toISOString()}] Local date and initial context created.`,
    );

    const wakeUpTime =
      request.wakeUpTime || userData.basicInfo?.wakeUpTime || "6:00 AM";
    const sleepTime =
      request.sleepTime || userData.basicInfo?.sleepTime || "9:00 PM";

    if (wakeUpTime) context += `I usually wake up around ${wakeUpTime}. `;
    if (sleepTime) context += `I usually go to sleep around ${sleepTime}. `;
    if (userData.basicInfo?.morningGoals) {
      context += `Some of my morning goals are ${userData.basicInfo?.morningGoals}. `;
    }
    if (userData.basicInfo?.eveningGoals) {
      context += `Some of my evening goals are ${userData.basicInfo?.eveningGoals}. `;
    }
    // Check dietNutrition map
    if (userData.dietNutrition) {
      const { nutritionCategories, recipeTags } = userData.dietNutrition;

      // Add favorite cuisines and foods
      if (nutritionCategories && nutritionCategories.length) {
        context += `Some of my favorite cuisines are ${nutritionCategories.join(", ")}. `;
      }
      if (recipeTags && recipeTags.length) {
        context += `Some foods I like to eat are ${recipeTags.join(", ")}. `;
      }
    }

    // Check financialPlanning map
    if (userData.financialPlanning) {
      const { planCategories } = userData.financialPlanning;
      if (planCategories && planCategories.length) {
        context += `I would like to learn and hear advice about portfolios of type: ${planCategories.join(", ")}. `;
      }
    }

    // Check lifestyleHealth map
    if (userData.lifestyleHealth) {
      const { family, martialStatus, workoutCategories, workoutTags } =
        userData.lifestyleHealth;
      if (martialStatus)
        context += `When comes to relationships I am ${martialStatus}. `;
      if (family) context += `Family situation: ${family}. `;
      if (workoutCategories && workoutCategories.length) {
        context += `To stay active some of the activities I am into are ${workoutCategories.join(", ")}. `;
      }
      if (workoutTags && workoutTags.length) {
        context += `To stay healthy and in good shape I would like to work on ${workoutTags.join(", ")}. `;
      }
    }

    // Check workSkills map
    if (userData.workSkills) {
      const { occupation, workStatus, hybridStatus, industries, courseTags } =
        userData.workSkills;

      if (occupation) context += `I work as a ${occupation}. `;
      if (workStatus)
        context += `My work status is ${workStatus}. I typically work 5 days a week and take weekends off. `;

      // Add hybrid status with dynamic text
      if (hybridStatus) {
        if (hybridStatus === "remote") {
          context += `I work remotely. `;
        } else if (hybridStatus === "in-office") {
          context += `I work on site. `;
        } else if (hybridStatus === "hybrid") {
          context += `I have a hybrid work schedule, splitting my time between remote work and office. `;
        }
      }

      // Add industries
      if (industries && industries.length) {
        context += `Some of the industries I am interested in are ${industries.join(", ")}. `;
      }

      // Add course tags
      if (courseTags && courseTags.length) {
        context += `Some topics I would like to learn more about are ${courseTags.join(", ")}. `;
      }
    }

    // Check moreInfo map
    if (userData.moreInfo) {
      const { additionalInfo } = userData.moreInfo;
      if (additionalInfo)
        context += `Additional info about me: ${additionalInfo}. `;
    }

    if (request.moreInfo) {
      context += `${request.moreInfo}. `;
    }

    // Determine which parts of customDayPreferences to use based on the type
    let customDayContext;
    if (request.type === "short") {
      customDayContext = `${customDayPreferences.perfectPerson} ${customDayPreferences.shortScheduleRequest} ${customDayPreferences.scheduleMustsRequest} ${customDayPreferences.jsonStructure}`;
    } else {
      customDayContext = `${customDayPreferences.perfectPerson} ${customDayPreferences.scheduleRequest} ${customDayPreferences.scheduleMustsRequest} ${customDayPreferences.jsonStructure}`;
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

    // Default values
    let model = "gpt-4o-mini";
    let maxTokens = 1500;

    // Adjust values based on the type parameter
    switch (request.type) {
      case "full":
        model = "gpt-4o-mini";
        maxTokens = 2048;
        break;
      case "expanded":
        model = "gpt-4o-mini";
        maxTokens = 4096;
        break;
      case "smart":
        model = "o1-mini";
        maxTokens = 8192;
        break;
    }

    // Fetch GPT response
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
    const currentDate = new Date();
    if (request.forTomorrow) currentDate.setDate(currentDate.getDate() + 1); // Move to tomorrow
    const localDate = new Date(
      currentDate.toLocaleString("en-US", { timeZone: "America/Toronto" }),
    );
    const todayId = localDate.toLocaleDateString("en-CA").split("T")[0];

    try {
      const sanitizedContent = sanitizeString(gptResponse);
      schedule = JSON.parse(sanitizedContent);
      // Add type and model to the schedule object

      schedule.type = request.type;
      schedule.model = model;
      (schedule.id = todayId),
        (schedule.createdAt = admin.firestore.FieldValue.serverTimestamp());
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

    exports
      .saveScheduleToFirestore(admin.firestore(), schedule, userId, todayId)
      .then(() =>
        console.log(
          `[${new Date().toISOString()}] Initiated saving schedule to Firestore.`,
        ),
      )
      .catch((error) =>
        console.error(
          `[${new Date().toISOString()}] Error during schedule save:`,
          error,
        ),
      );

    console.log(
      `[${new Date().toISOString()}] Completed processing in lambdaHandler.`,
    );

    await sendMessage(connectionId, endpoint, {
      status: "success",
      schedule,
    });
    return { statusCode: 200 };
  } catch (error) {
    console.error("Error:", error);
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
  today,
) => {
  try {
    const startTime = new Date();
    console.log(
      `[${startTime.toISOString()}] Starting save schedule to Firestore.`,
    );
    const scheduleRef = firestore
      .collection("users")
      .doc(userId)
      .collection("schedules")
      .doc(today);

    await scheduleRef.set({
      ...schedule,
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
