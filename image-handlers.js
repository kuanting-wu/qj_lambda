// Handle Proxy Image
const handleProxyImage = async (event) => {
    const { bvid } = event.queryStringParameters;
    if (!bvid) {
        return { statusCode: 400, body: JSON.stringify({ error: 'bvid query parameter is required' }) };
    }

    // Logic for fetching and returning the image from external source (e.g., Bilibili)
    return { statusCode: 200, body: 'Image data' };
};

module.exports = {
    handleProxyImage,
};