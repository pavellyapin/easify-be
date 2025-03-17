const {
  getDataFromS3,
  getOpenAIObject,
  getChatGPTPrompt,
  sanitizeString,
} = require("/opt/nodejs/utils");
const yahooFinance = require("yahoo-finance2").default;
const { parseISO, format, isValid } = require("date-fns");
const admin = require("firebase-admin");

exports.lambdaHandler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));

    const [
      chatGPTSecret,
      portfolioListRequest,
      portfolioDetailsRequest,
      serviceAccountKey,
    ] = await Promise.all([
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.SECRETS_S3_KEY_NAME,
        "gptSecret",
      ),
      getDataFromS3(
        process.env.PROMPTS_S3_BUCKET_NAME,
        process.env.PROMPTS_S3_KEY_NAME,
        "portfolioListRequest",
      ),
      getDataFromS3(
        process.env.PROMPTS_S3_BUCKET_NAME,
        process.env.PROMPTS_S3_KEY_NAME,
        "portfolioDetailsRequest",
      ),
      getDataFromS3(
        process.env.SECRETS_S3_BUCKET_NAME,
        process.env.FIREBASE_ACCOUNT_S3_KEY_NAME,
      ),
    ]);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountKey),
      });
    }

    const firestore = admin.firestore();
    const openai = await getOpenAIObject(chatGPTSecret);

    // Step 1: Generate portfolio list
    const portfolioListResponse = await getChatGPTPrompt(
      openai,
      [{ role: "user", content: portfolioListRequest }],
      4096,
      "gpt-4o-mini",
    );

    console.log(`GPT response "${portfolioListResponse}"`);

    let portfolioList = JSON.parse(sanitizeString(portfolioListResponse));

    for (const portfolio of portfolioList.portfolios) {
      // Step 2: Check if portfolio with the same name already exists
      const existingPortfolioSnapshot = await firestore
        .collection("portfolios")
        .where("name", "==", portfolio.name)
        .limit(1)
        .get();

      if (!existingPortfolioSnapshot.empty) {
        console.log(
          `Portfolio with name "${portfolio.name}" already exists. Skipping...`,
        );
        continue; // Skip to the next portfolio
      }

      // Step 3: Generate portfolio details
      const portfolioDetailsResponse = await getChatGPTPrompt(
        openai,
        [
          {
            role: "user",
            content: portfolioDetailsRequest
              .replace("{name}", portfolio.name)
              .replace("{description}", portfolio.description)
              .replace("{allocation}", JSON.stringify(portfolio.allocations))
              .replace("{annualReturn}", portfolio.annualReturn)
              .replace("{riskLevel}", portfolio.riskLevel),
          },
        ],
        4096,
        "gpt-4o-mini",
      );

      let detailedPortfolio = JSON.parse(
        sanitizeString(portfolioDetailsResponse),
      );

      // Step 4: Enrich each asset class with historical data
      await enrichPortfolioWithHistoricalData(detailedPortfolio, firestore);

      // Step 5: Calculate portfolio value for each date
      detailedPortfolio.portfolioValues =
        await calculatePortfolioValue(detailedPortfolio);

      // Step 6: Generate the holdings array
      detailedPortfolio.holdings = generateHoldingsArray(detailedPortfolio);

      // Merge details into the portfolio
      const mergedPortfolio = { ...portfolio, ...detailedPortfolio };

      // Save to Firestore
      await savePortfolioToFirestore(firestore, mergedPortfolio);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Portfolios processed successfully." }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// Enrich portfolio with historical data
async function enrichPortfolioWithHistoricalData(portfolio, firestore) {
  const assetClasses = [
    "govBonds",
    "internationalEquities",
    "globalEquities",
    "usEquities",
    "emergingMarketEquities",
    "gold",
    "cryptocurrencies",
  ];

  for (const assetClass of assetClasses) {
    if (portfolio[assetClass]) {
      // Filter holdings with successful historical data fetch
      portfolio[assetClass] = await Promise.all(
        portfolio[assetClass].map(async (holding) => {
          try {
            if (holding.ticker) {
              const historicalData = await fetchHistoricalData(
                holding,
                assetClass,
                firestore,
              );

              // If historical data is fetched successfully, assign it
              if (historicalData && historicalData.length > 0) {
                holding.historicalData = historicalData;
                return holding;
              } else {
                console.warn(
                  `No historical data found for ticker: ${holding.ticker}`,
                );
              }
            }
          } catch (error) {
            console.error(
              `Error fetching historical data for ticker: ${holding.ticker}`,
              error,
            );
          }
          return null; // Mark as null if not successful
        }),
      );

      // Remove holdings that are null
      portfolio[assetClass] = portfolio[assetClass].filter(
        (holding) => holding !== null,
      );
    }
  }
}

function generateHoldingsArray(portfolio) {
  const holdings = [];
  const assetClasses = [
    "govBonds",
    "internationalEquities",
    "globalEquities",
    "usEquities",
    "emergingMarketEquities",
    "gold",
    "cryptocurrencies",
  ];

  for (const assetClass of assetClasses) {
    if (portfolio[assetClass]) {
      for (const holding of portfolio[assetClass]) {
        if (holding.ticker && holding.name) {
          holdings.push({
            name: holding.name,
            ticker: holding.ticker,
          });
        }
      }
    }
  }

  return holdings;
}

// Fetch historical data for a ticker, prioritizing Firestore

async function fetchHistoricalData(holding, assetClass, firestore) {
  try {
    console.log(`Checking Firestore for ticker: ${holding.ticker}`);

    const tickersCollection = firestore.collection("tickers");
    const tickerDoc = await tickersCollection.doc(holding.ticker).get();

    // Define the cutoff date
    const cutoffDate = parseISO("2025-01-01");
    if (tickerDoc.exists) {
      console.log(`Ticker ${holding.ticker} found in Firestore.`);
      const storedHistoricalData = tickerDoc.data().historicalData;

      // Dynamically calculate `unitsHeld` and `value` before returning
      const filteredHistoricalData = storedHistoricalData
        .filter((dataPoint) => parseISO(dataPoint.date) <= cutoffDate)
        .map((dataPoint) => ({
          date: dataPoint.date, // Already formatted in Firestore
          close: dataPoint.close,
          unitsHeld: holding.unitsHeld, // Use current holding's unitsHeld
          value: dataPoint.close * holding.unitsHeld, // Calculate value dynamically
        }));

      return filteredHistoricalData;
    }

    console.log(
      `Ticker ${holding.ticker} not found in Firestore. Fetching from Yahoo Finance.`,
    );

    // Fetch historical data from Yahoo Finance
    const historicalData = await yahooFinance.historical(holding.ticker, {
      period1: "2018-01-01", // Start date for historical data
      period2: new Date().toISOString(), // End date (current date)
      interval: "1mo", // Monthly data points
    });

    // Format the data
    const formattedData = historicalData.map((data) => {
      // Handle different formats of the date field
      let parsedDate;
      if (typeof data.date === "string") {
        parsedDate = parseISO(data.date); // Parse ISO string
      } else if (data.date instanceof Date) {
        parsedDate = data.date; // Already a Date object
      } else {
        throw new Error(
          `Invalid date format for ${holding.ticker}: ${data.date}`,
        );
      }

      // Check validity and adjust for crypto if needed
      if (!isValid(parsedDate)) {
        throw new Error(
          `Invalid parsed date for ${holding.ticker}: ${data.date}`,
        );
      }

      const adjustedDate = adjustToNextMonthIfEndOfMonth(parsedDate);

      return {
        date: format(adjustedDate, "yyyy-MM-dd"), // Format as YYYY-MM-DD
        close: data.close,
      };
    });

    // Save the formatted data into the `tickers` collection (without unitsHeld and value)
    await tickersCollection.doc(holding.ticker).set({
      ticker: holding.ticker,
      name: holding.name,
      historicalData: formattedData,
      assetClass,
      lastUpdated: new Date().toISOString(),
    });

    console.log(`Ticker ${holding.ticker} saved to Firestore.`);

    // Dynamically calculate `unitsHeld` and `value` before returning
    const filteredHistoricalData = formattedData
      .filter((dataPoint) => parseISO(dataPoint.date) <= cutoffDate)
      .map((dataPoint) => ({
        date: dataPoint.date, // Already formatted in Firestore
        close: dataPoint.close,
        unitsHeld: holding.unitsHeld, // Use current holding's unitsHeld
        value: dataPoint.close * holding.unitsHeld, // Calculate value dynamically
      }));

    return filteredHistoricalData;
  } catch (error) {
    console.error(
      `Error fetching historical data for ticker: ${holding.ticker}`,
      error,
    );
    return [];
  }
}

function adjustToNextMonthIfEndOfMonth(date) {
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1); // Move one day forward

  if (nextDay.getMonth() !== date.getMonth()) {
    // If the month changes, this was the last day of the previous month
    nextDay.setDate(1); // Set to the 1st of the next month
  } else {
    // Otherwise, return the original date
    return date;
  }

  return nextDay;
}

// Generate overall portfolio value for each date
async function calculatePortfolioValue(portfolio) {
  const portfolioValues = {};

  const assetClasses = [
    "govBonds",
    "internationalEquities",
    "globalEquities",
    "usEquities",
    "emergingMarketEquities",
    "gold",
    "cryptocurrencies",
  ];

  for (const assetClass of assetClasses) {
    if (portfolio[assetClass]) {
      for (const holding of portfolio[assetClass]) {
        if (holding.historicalData) {
          for (const dataPoint of holding.historicalData) {
            const { date, value } = dataPoint;

            // Initialize the date entry if not exists
            if (!portfolioValues[date]) {
              portfolioValues[date] = {
                date,
                goldValue: 0,
                bondsValue: 0,
                internationalEquitiesValue: 0,
                globalEquitiesValue: 0,
                usEquitiesValue: 0,
                emergingMarketEquitiesValue: 0,
                cryptoValue: 0,
                totalValue: 0,
              };
            }

            // Add the value to the corresponding asset class
            switch (assetClass) {
              case "gold":
                portfolioValues[date].goldValue += value;
                break;
              case "govBonds":
                portfolioValues[date].bondsValue += value;
                break;
              case "internationalEquities":
                portfolioValues[date].internationalEquitiesValue += value;
                break;
              case "globalEquities":
                portfolioValues[date].globalEquitiesValue += value;
                break;
              case "usEquities":
                portfolioValues[date].usEquitiesValue += value;
                break;
              case "emergingMarketEquities":
                portfolioValues[date].emergingMarketEquitiesValue += value;
                break;
              case "cryptocurrencies":
                portfolioValues[date].cryptoValue += value;
                break;
            }

            // Add the value to the total portfolio value
            portfolioValues[date].totalValue += value;
          }
        }
      }
    }
  }

  // Convert the portfolioValues object into an array
  const portfolioValueArray = Object.values(portfolioValues);

  return portfolioValueArray;
}

// Save the portfolio to Firestore
async function savePortfolioToFirestore(firestore, portfolio) {
  const portfoliosCollection = firestore.collection("portfolios");
  portfolio.createdDate = new Date().toISOString();
  const document = await portfoliosCollection.add(portfolio);
  console.log(`Portfolio saved with ID: ${document.id}`);
}
