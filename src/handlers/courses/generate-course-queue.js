const AWS = require("aws-sdk");
const sns = new AWS.SNS();

exports.lambdaHandler = async (event) => {
  try {
    // Log the full incoming event for debugging purposes
    console.log("Received event:", JSON.stringify(event, null, 2));

    // Extract and log the SNS message
    const snsMessage = event.Records[0].Sns.Message;
    console.log("SNS Message received:", snsMessage);

    // Parse the message and log the courses array
    const courses = JSON.parse(snsMessage).courses;
    console.log("Parsed courses:", courses);

    // Validate if courses is an array
    if (!Array.isArray(courses)) {
      throw new Error("Input should be an array of course names.");
    }

    // Log the SNS Topic ARN from the environment variable
    const topicArn = process.env.SNS_TOPIC_ARN;
    console.log("SNS Topic ARN:", topicArn);

    // Check if the topicArn is set
    if (!topicArn) {
      throw new Error("SNS_TOPIC_ARN environment variable is not set.");
    }

    // Loop through courses and send each course as an SNS message
    for (const courseObj of courses) {
      const courseName = courseObj.name ? courseObj.name : courseObj;
      console.log(`Processing course: ${courseName}`); // Log the current course name

      const snsParams = {
        Message: JSON.stringify({ courseName }), // Log message structure
        TopicArn: topicArn, // Use the SNS topic ARN from the environment variable
      };

      // Log the SNS parameters before sending the message
      console.log("SNS Params:", JSON.stringify(snsParams, null, 2));

      // Publish SNS message for each course
      const publishResponse = await sns.publish(snsParams).promise();

      // Log the publish response from SNS
      console.log(
        `SNS message sent for course: ${courseName}, Response:`,
        publishResponse,
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "All SNS messages sent successfully" }),
    };
  } catch (error) {
    // Log the error for debugging
    console.error("Error sending SNS messages:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
