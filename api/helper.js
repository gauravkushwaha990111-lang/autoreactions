let emojiQueue = [];

// Helper function to select random emoji-reaction
export function getRandomPositiveReaction(reactionArray) {
    if (!reactionArray || reactionArray.length === 0) return null;

    // Agar admin ne emoji change kiye hain, toh purani queue update karo
    emojiQueue = emojiQueue.filter(r => reactionArray.includes(r));

    if (emojiQueue.length === 0) {
        // Queue khali hone par saare emojis dobara dalo aur unhe shuffle (mix) kardo
        emojiQueue = [...reactionArray];
        for (let i = emojiQueue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [emojiQueue[i], emojiQueue[j]] = [emojiQueue[j], emojiQueue[i]];
        }
    }

    // Sequence me ek-ek karke emoji return karo bina repeat kiye
    return emojiQueue.pop();
}

// Get Emoji Array from String emoji set
export function splitEmojis(emojiString) {
    if (!emojiString) return [];
    const emojiRegex = /(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Emoji_Modifier_Base})/gu;
    return emojiString.match(emojiRegex) || [];
}

// Helper function to return HTML with correct headers
export function returnHTML(content) {
    return new Response(content, {
        headers: { 'content-type': 'text/html' },
    });
}