/* eslint-disable no-case-declarations */
// Import necessary modules and functions
const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
  verifyAndDecodeToken,
  HEADERS,
} = require("/opt/nodejs/utils");
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  try {
    const [chatGPTSecret, easifyRequest, serviceAccountKey] = await Promise.all(
      [
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.SECRETS_S3_KEY_NAME,
          "gptSecret",
        ),
        getDataFromS3(
          process.env.PROMPTS_S3_BUCKET_NAME,
          process.env.PROMPTS_S3_KEY_NAME,
          "easifyRequest",
        ),
        getDataFromS3(
          process.env.SECRETS_S3_BUCKET_NAME,
          process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
        ),
      ],
    );

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
      console.log(`[${new Date().toISOString()}] Firebase initialized.`);
    }

    const authResult = await verifyAndDecodeToken(event, admin);
    if (authResult.statusCode !== 200) return authResult;

    const userId = authResult.decodedToken.uid;
    console.log(
      `[${new Date().toISOString()}] Token verified for userId: ${userId}.`,
    );

    const body = JSON.parse(event.body);
    const { type, item } = body.easifyRequest;
    if (!type || !item || !item.id) {
      throw new Error("Missing required parameters: type or item.");
    }

    // Firestore collection lookup
    const collection = {
      course: "courses",
      workout: "workouts",
      recipe: "recipes",
      portfolio: "portfolios",
      industry: "industries",
    }[type];

    if (!collection) {
      throw new Error(
        "Invalid type. Must be 'course', 'workout', or 'recipe', 'portfolio', 'industry'.",
      );
    }

    const docRef = admin.firestore().collection(collection).doc(item.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new Error(`No document found for ID: ${item.id}`);
    }

    const data = doc.data();
    let description, promptContext;

    // Max tokens and model variables
    let maxTokens = 1500;
    const model = "gpt-4o-mini";

    // Prompt construction based on type
    switch (type) {
      case "industry":
        maxTokens = 2000;
        const part = item.part;
      
        let industryFieldMapping = {
          overview: ["historicalSignificance", "growthRate", "marketSize", "yearStarted"],
          skillsInDemand: "skillsInDemand",
          topCompany: "topCompanies",
          customerBase: "customerBase",
          geographicalHotspots: "geographicalHotspots",
          opportunities: "futureOpportunities",
          notableTechnologies: "notableTechnologies",
          requiredEducation: "educationalRequirements",
          workConditions: "workEnvironment",
          jobProspects: "jobOutlook",
          majorTrends: "majorTrends",
          challenges: "challenges",
        };
      
        if (!industryFieldMapping[part]) {
          throw new Error(`Invalid industry part: ${part}`);
        }
      
        let formattedIndustryData;
      
        if (part === "overview") {
          // ✅ Fetch multiple fields from `detailedInfo`
          const historicalSignificance = data.detailedInfo?.historicalSignificance || "No historical significance available";
          const growthRate = data.detailedInfo?.growthRate || "Growth rate not available";
          const marketSize = data.detailedInfo?.marketSize || "Market size unknown";
          const yearStarted = data.detailedInfo?.yearStarted ? `Established in ${data.detailedInfo.yearStarted}` : "Year started unknown";
      
          formattedIndustryData = `${yearStarted}\nGrowth Rate: ${growthRate}\nMarket Size: ${marketSize}\nHistorical Significance: ${historicalSignificance}`;
        } else {
          // ✅ Extract single field normally
          const industryData = data[industryFieldMapping[part]];
      
          formattedIndustryData = Array.isArray(industryData)
            ? industryData
                .map((entry) =>
                  typeof entry === "string"
                    ? entry
                    : entry.name
                      ? `${entry.name}: ${entry.description || ""}`
                      : entry.description || "",
                )
                .join("\n• ")
            : typeof industryData === "object"
              ? JSON.stringify(industryData, null, 2)
              : industryData || "No data available";
        }
      
        // ✅ Custom description for overview
        description = `Industry Name: ${data.name}\nIndustry Category: ${data.category}\n${part} Information:\n${formattedIndustryData}`;
      
        // ✅ Custom promptContext for GPT
        promptContext = `I am exploring the industry "${data.name}", which falls under "${data.category}". I want to know more about "${part}". Here are the details:\n${formattedIndustryData}.\n${easifyRequest}`;
      
        break;

      case "portfolio":
        maxTokens = 4000;
        const assetClass = data[item.assetClass];
        const holding = assetClass[item.holdingIndex];
        const historicalData = holding.historicalData;

        // Filter out invalid data and extract only close and date
        const cleanedHistoricalData = historicalData
          .filter((entry) => entry?.close && entry?.date) // Filter valid entries
          .map((entry) => ({
            date: entry.date,
            close: entry.close.toFixed(2), // Format to 2 decimals
          }));

        // Convert to a readable string for the prompt
        const historicalDataText = cleanedHistoricalData
          .map((entry) => `${entry.date}: $${entry.close}`)
          .join(", ");

        promptContext = `I am analyzing the portfolio "${data.name}", ${data.description}. In the asset class "${item.assetClass}". The holding "${holding.name}", expand about the company. Historical prices: ${historicalDataText}. ${easifyRequest}`;
        break;

      case "course":
        const chapter = data.chapters?.[item.chapterNumber];
        const topic = chapter?.topics?.[item.topicNumber];
        const point = topic?.points?.[item.pointIndex];
        description = `${point?.title} - ${point?.desc} - ${point?.content}`;

        promptContext = `I am reading the course "${data.name}". In chapter "${chapter?.name}", topic "${topic?.name}", and point "${point?.title}", it says: "${description}". ${easifyRequest}`;
        break;

      case "workout":
        const exercises =
          item.stage === 1 ? data.warmUp.exercises : data.routine.exercises;
        const exercise = exercises?.[item.exerciseIndex];
        description = exercise?.name + " " + exercise?.description;

        promptContext = `I am doing the workout "${data.name}". The exercise "${exercise?.name}" is described as: "${description}". ${easifyRequest}`;
        break;

      case "recipe":
        const instructions =
          item.stage === 1 ? data.prepare : data.instructions;
        const instruction = instructions?.[item.instructionIndex];
        description = instruction?.name + " " + instruction?.description;

        promptContext = `I am following the recipe "${data.name}". In the step "${instruction?.name}", it says: "${description}". ${easifyRequest}`;
        break;

      default:
        throw new Error("Unhandled type in switch case.");
    }

    const contextMessage = {
      role: "user",
      content: promptContext,
    };

    console.log(
      `[${new Date().toISOString()}] Prepared context message for GPT request.`,
    );

    const openai = await getOpenAIObject(chatGPTSecret);
    console.log(
      `[${new Date().toISOString()}] Initialized OpenAI object with provided secret.`,
    );

    // GPT response
    const gptResponse = await getChatGPTPrompt(
      openai,
      [contextMessage],
      maxTokens,
      model,
    );

    console.log(
      `[${new Date().toISOString()}] Received response from GPT model.`,
    );

    let easifyResponse;
    try {
      // Sanitize and parse the GPT response
      const sanitizedContent = sanitizeString(gptResponse);
      easifyResponse = JSON.parse(sanitizedContent);
      console.log(
        `[${new Date().toISOString()}] Parsed GPT response and converted to JSON format.`,
      );
    } catch (parseError) {
      console.error(
        `[${new Date().toISOString()}] Error parsing GPT response to JSON:`,
        parseError,
      );
      throw new Error("Invalid format from ChatGPT");
    }
    // Save request and response to Firebase with a unique document ID
    const userDocRef = admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection("easifyResponses");

    const responseDoc = {
      type,
      itemId: item.id,
      request: body.easifyRequest,
      response: easifyResponse,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userDocRef.add(responseDoc);

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify(responseDoc),
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error encountered:`, error);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
