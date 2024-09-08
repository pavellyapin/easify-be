const AWS = require('aws-sdk');
const sns = new AWS.SNS();

exports.lambdaHandler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));

        // Log the body of the request
        const body = JSON.parse(event.body);
        console.log('Parsed body:', JSON.stringify(body, null, 2));

        const { phoneNumber, shoppingList } = body;

        // Debug logs for phone number and shopping list
        console.log('Phone number:', phoneNumber);
        console.log('Shopping list:', shoppingList);

        if (!phoneNumber || !shoppingList) {
            console.error('Missing phoneNumber or shoppingList');
            return {
                statusCode: 400,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
                },
                body: JSON.stringify({ message: 'phoneNumber and shoppingList are required.' }),
            };
        }

        const message = `Your shopping list:\n${shoppingList.join('\n')}`;
        console.log('Constructed message:', message);

        const params = {
            Message: message,
            PhoneNumber: phoneNumber
        };

        // Log the SNS publish parameters
        console.log('SNS Publish params:', JSON.stringify(params, null, 2));

        // Attempt to send the message
        const result = await sns.publish(params).promise();

        // Log the SNS publish result
        console.log('SNS publish result:', JSON.stringify(result, null, 2));

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ message: 'Shopping list sent successfully!' }),
        };
    } catch (error) {
        console.error('Error sending shopping list:', error.message);
        console.error('Error details:', error);

        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
            },
            body: JSON.stringify({ message: 'Internal server error.' }),
        };
    }
};